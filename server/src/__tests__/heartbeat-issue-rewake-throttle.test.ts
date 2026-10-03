import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  autonomousBudgetReservations,
  autonomousProviderCircuits,
  budgetIncidents,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  normalizeExecutionBudgetTerminal,
  SESSION_ROLLOVER_RETRY_REASON,
  SESSION_ROLLOVER_WAKE_REASON,
} from "../services/heartbeat.ts";
import { loadIssueTaskStateFingerprint } from "../services/issue-continuity-state.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";
import { recordAutonomousProviderCircuitOutcome } from "../services/autonomous-provider-circuit.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake throttle test run.",
    provider: "test",
    model: "test-model",
    budgetTelemetry: {
      providerRequestId: randomUUID(),
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      runtimeMs: 100,
      costMicrousd: 1,
      rateCardVersion: "test-v1",
    },
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue rewake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

it("lazily interprets historical budget terminals without rewriting or guessing", () => {
  expect(normalizeExecutionBudgetTerminal({
    errorCode: "context_budget_exceeded",
    resultJson: { budgetFailureReason: "cumulative_input_tokens_exceeded" },
  } as any)).toBe("execution_input_budget_exceeded");
  expect(normalizeExecutionBudgetTerminal({
    errorCode: "context_budget_exceeded",
    resultJson: { budgetFailureReason: "context_window_exceeded" },
  } as any)).toBe("model_context_limit_exceeded");
  expect(normalizeExecutionBudgetTerminal({
    errorCode: "context_budget_exceeded",
    resultJson: {},
  } as any)).toBe("legacy_budget_terminal_unclassified");
});

describeEmbeddedPostgres("heartbeat issue rewake throttle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes (a heartbeat_runs delete deadlocks on the ON
    // DELETE SET NULL cascade to issues). The shared drain also awaits an
    // in-flight wakeup that is still before run registration, which a plain run
    // table status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Issue rewake throttle test run.",
      provider: "test",
      model: "test-model",
      budgetTelemetry: {
        providerRequestId: randomUUID(),
        requestCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        runtimeMs: 100,
        costMicrousd: 1,
        rateCardVersion: "test-v1",
      },
    }));
    // Post-run bookkeeping (run-event records, follow-up wake scheduling) can
    // still write for a moment after a run reaches a terminal status, so a
    // single delete sweep can hit a foreign-key violation when a late insert
    // lands between two deletes. Retry the sweep until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(costEvents);
        await db.delete(issueRecoveryActions);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(autonomousBudgetReservations);
        await db.delete(budgetIncidents);
        await db.delete(budgetPolicies);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function validExecutionCheckpoint() {
    return {
      version: 1 as const,
      workspace: {
        cwd: "/workspace/project",
        gitHead: "0123456789abcdef0123456789abcdef01234567",
        branch: "feat/checkpoint",
        statusSha256: "a".repeat(64),
      },
      patch: {
        kind: "git_diff" as const,
        sha256: "b".repeat(64),
        bytes: 128,
      },
      tests: {
        status: "passed" as const,
        commands: [{ command: "pnpm test", exitCode: 0 }],
      },
      blockers: {
        status: "clear" as const,
        evidence: ["No unresolved issue dependency"],
      },
      nextAction: "Run the focused typecheck.",
    };
  }

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      autonomousExecutionPaused: false,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted import mission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(budgetPolicies).values([
      { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "lifetime", amount: 80 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "lifetime", amount: 640_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "lifetime", amount: 80_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "lifetime", amount: 3_000_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "lifetime", amount: 10_000_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    finishedSecondsAgo: number;
    startedSecondsAgo?: number;
    sessionIdAfter?: string;
    workOutcome?: "productive" | "blocked" | "no_progress" | "provider_error" | "cancelled";
    stateFingerprintBefore?: string;
    stateFingerprintAfter?: string;
    noProgressStreak?: number;
    continuityCircuitState?: "closed" | "open";
    continuityCircuitOpenedAt?: Date;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = input.startedSecondsAgo === undefined
      ? new Date(finishedAt.getTime() - 5_000)
      : new Date(Date.now() - input.startedSecondsAgo * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      sessionIdAfter: input.sessionIdAfter,
      workOutcome: input.workOutcome,
      stateFingerprintBefore: input.stateFingerprintBefore,
      stateFingerprintAfter: input.stateFingerprintAfter,
      noProgressStreak: input.noProgressStreak,
      continuityCircuitState: input.continuityCircuitState,
      continuityCircuitOpenedAt: input.continuityCircuitOpenedAt,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  function assignmentWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("contains a failing fake provider within one logical execution", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementation(async () => {
      const providerRequestId = randomUUID();
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "overloaded",
        errorFamily: "transient_upstream",
        errorMessage: "Synthetic upstream overload",
        provider: "test",
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        usageBasis: "per_run" as const,
        executionRecovery: { kind: "provider", providerWorkStarted: true },
        resultJson: {
          errorFamily: "transient_upstream",
          conversationContinuation: "continue_conversation_v1",
          executionRecovery: { kind: "provider", providerWorkStarted: true },
          apiCalls: 1,
          successfulProviderResponses: 0,
          usageTelemetryComplete: true,
          costStatus: "actual",
          cost_usd: 0.000001,
          providerRequestIds: [providerRequestId],
        },
        budgetTelemetry: {
          providerRequestId,
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 5,
          runtimeMs: 100,
          costMicrousd: 1,
          rateCardVersion: "test-v1",
        },
      };
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const firstPassRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(firstPassRuns).toHaveLength(2);
    const rootRun = firstPassRuns.find((run) => run.retryOfRunId === null);
    const retryRun = firstPassRuns.find((run) => run.retryOfRunId === rootRun?.id);
    expect(rootRun).toMatchObject({ status: "failed", errorCode: "overloaded" });
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      contextSnapshot: {
        logicalExecution: {
          key: `issue:${issueId}:generation:${rootRun?.id}`,
          rootRunId: rootRun?.id,
          providerAttempt: 2,
        },
      },
    });

    await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 300_000));
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const finalRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(finalRuns).toHaveLength(2);
    expect(finalRuns.every((run) => run.status === "failed")).toBe(true);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "blocked" }),
    ]);
    await expect(
      db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId)),
    ).resolves.toEqual([
      expect.objectContaining({ status: "active", ownerType: "board" }),
    ]);
    await expect(
      db.select().from(costEvents).where(eq(costEvents.companyId, companyId)),
    ).resolves.toHaveLength(2);
  });

  it("passes the committed run envelope to the adapter context", async () => {
    const { agentId, issueId } = await seedCompanyAgentIssue();

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const call = mockAdapterExecute.mock.calls.at(-1);
    expect(call?.[0]?.autonomousBudgetEnvelope).toEqual({
      requestCount: 8,
      inputTokens: 64_000,
      outputTokens: 8_000,
      runtimeMs: 300_000,
      costMicrousd: 250_000,
    });
  });

  it("does not classify exit-zero compression cooldown as productive when no provider answered", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ title: "Changed independently during cooldown" }).where(eq(issues.id, issueId));
      return {
        exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
        resultJson: { successfulProviderResponses: 0, apiCalls: 0,
          usageTelemetryComplete: true, turn_exit_reason: "compression_cooldown" },
        budgetTelemetry: {
          providerRequestId: randomUUID(), requestCount: 0, inputTokens: 0,
          outputTokens: 0, runtimeMs: 100, costMicrousd: 0, rateCardVersion: "test-v1",
        },
      };
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select({ status: heartbeatRuns.status, workOutcome: heartbeatRuns.workOutcome,
      resultJson: heartbeatRuns.resultJson,
      stateFingerprintBefore: heartbeatRuns.stateFingerprintBefore,
      stateFingerprintAfter: heartbeatRuns.stateFingerprintAfter }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    const run = runs.find((row) => (row.resultJson as Record<string, unknown> | null)?.successfulProviderResponses === 0);
    expect(run).toBeDefined();
    expect(run?.stateFingerprintBefore).not.toBe(run?.stateFingerprintAfter);
    expect(run?.status).toBe("failed");
    expect(run?.workOutcome).toBe("telemetry_missing");
  });

  it("does not classify a response-free Hermes run as productive when issue state changes", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const providerRequestId = randomUUID();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ title: "Changed independently during empty response" }).where(eq(issues.id, issueId));
      return {
        exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 }, usageBasis: "per_run" as const,
        resultJson: { result: "", apiCalls: 1, successfulProviderResponses: 1,
          usageTelemetryComplete: true, costStatus: "actual", cost_usd: 0.000001,
          providerRequestIds: [providerRequestId] },
        budgetTelemetry: { providerRequestId, requestCount: 1, inputTokens: 10,
          outputTokens: 5, runtimeMs: 100, costMicrousd: 1, rateCardVersion: "test-v1" },
      };
    });
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select({ status: heartbeatRuns.status, workOutcome: heartbeatRuns.workOutcome,
      resultJson: heartbeatRuns.resultJson, stateFingerprintBefore: heartbeatRuns.stateFingerprintBefore,
      stateFingerprintAfter: heartbeatRuns.stateFingerprintAfter })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const run = runs.find((row) => (row.resultJson as Record<string, unknown> | null)?.successfulProviderResponses === 1);
    expect(run?.stateFingerprintBefore).not.toBe(run?.stateFingerprintAfter);
    expect(run?.status).toBe("succeeded");
    expect(run?.workOutcome).toBe("no_progress");
  });

  it("keeps the budget reservation and blocks continuation when Hermes reports incomplete usage", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      resultJson: { apiCalls: 1, successfulProviderResponses: 1, usageTelemetryComplete: false },
      budgetTelemetry: {
        providerRequestId: randomUUID(), requestCount: 1, inputTokens: 10,
        outputTokens: 5, runtimeMs: 100, costMicrousd: 1, rateCardVersion: "test-v1",
      },
    }));

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select({ status: heartbeatRuns.status, workOutcome: heartbeatRuns.workOutcome,
      resultJson: heartbeatRuns.resultJson,
      errorCode: heartbeatRuns.errorCode, continuityCircuitState: heartbeatRuns.continuityCircuitState })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const run = runs.find((row) => (row.resultJson as Record<string, unknown> | null)?.usageTelemetryComplete === false);
    expect(run).toMatchObject({ status: "failed", workOutcome: "telemetry_missing",
      errorCode: "telemetry_missing", continuityCircuitState: "open" });
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).not.toBe("reconciled");
  });

  it("reconciles an attributed OpenAI Codex subscription response without metered cost", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false,
      provider: "openai-codex", model: "gpt-5.6-sol",
      usage: { inputTokens: 35_643, outputTokens: 468 }, usageBasis: "per_run",
      resultJson: {
        result: "Finished", provider: "openai-codex", billingType: "subscription",
        apiCalls: 7, successfulProviderResponses: 6,
        usageTelemetryComplete: false, budgetTelemetryComplete: true,
        costStatus: "included", costUnavailableReason: null, cost_usd: 0,
        providerRequestIds: [
          "resp_subscription_1", "resp_subscription_2", "resp_subscription_3",
          "resp_subscription_4", "resp_subscription_5", "resp_subscription_6",
        ],
      },
      budgetTelemetry: {
        providerRequestId: "resp_subscription_1", requestCount: 7,
        inputTokens: 35_643, outputTokens: 468, runtimeMs: 100, costMicrousd: 0,
        rateCardVersion: "openai-codex-subscription-v1",
      },
    }));

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("reconciled");
    const runs = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const run = runs.find((row) =>
      (row.resultJson as Record<string, unknown> | null)?.billingType === "subscription");
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("retains the reservation when Hermes cost is estimated despite nominal budget telemetry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      resultJson: { result: "Finished", apiCalls: 1, successfulProviderResponses: 1,
        usageTelemetryComplete: true, costStatus: "estimated", costUnavailableReason: null },
      budgetTelemetry: { providerRequestId: randomUUID(), requestCount: 1, inputTokens: 10,
        outputTokens: 5, runtimeMs: 100, costMicrousd: 1, rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("retained_missing_telemetry");
    const runs = await db.select({ workOutcome: heartbeatRuns.workOutcome, errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const run = runs.find((row) => (row.resultJson as Record<string, unknown> | null)?.costStatus === "estimated");
    expect(run).toMatchObject({ workOutcome: "telemetry_missing", errorCode: "telemetry_missing" });
  });

  it("retains the reservation when budget telemetry names a different provider request", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      resultJson: { result: "Finished", apiCalls: 1, successfulProviderResponses: 1,
        usageTelemetryComplete: true, costStatus: "actual", costUnavailableReason: null,
        providerRequestIds: ["gen-response-actual"] },
      budgetTelemetry: { providerRequestId: "gen-different", requestCount: 1, inputTokens: 10,
        outputTokens: 5, runtimeMs: 100, costMicrousd: 1, rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("retained_missing_telemetry");
  });

  it("retains the reservation when Hermes reported cost differs from budget telemetry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      resultJson: { result: "Finished", apiCalls: 1, successfulProviderResponses: 1,
        usageTelemetryComplete: true, costStatus: "actual", costUnavailableReason: null,
        cost_usd: 0.002, providerRequestIds: ["gen-response-actual"] },
      budgetTelemetry: { providerRequestId: "gen-response-actual", requestCount: 1,
        inputTokens: 10, outputTokens: 5, runtimeMs: 100, costMicrousd: 1,
        rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("retained_missing_telemetry");
  });

  it("retains the reservation when Hermes usage differs from budget telemetry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      usage: { inputTokens: 100, outputTokens: 5 }, usageBasis: "per_run",
      resultJson: { result: "Finished", apiCalls: 1, successfulProviderResponses: 1,
        usageTelemetryComplete: true, costStatus: "actual", costUnavailableReason: null,
        cost_usd: 0.002, providerRequestIds: ["gen-response-actual"] },
      budgetTelemetry: { providerRequestId: "gen-response-actual", requestCount: 1,
        inputTokens: 10, outputTokens: 5, runtimeMs: 100, costMicrousd: 2000,
        rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("retained_missing_telemetry");
  });

  it("reconciles one matching Hermes request only with actual cost evidence", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 }, usageBasis: "per_run",
      resultJson: { result: "Finished", apiCalls: 1, successfulProviderResponses: 1,
        usageTelemetryComplete: true, costStatus: "actual", costUnavailableReason: null,
        cost_usd: 0.002, providerRequestIds: ["gen-response-actual"] },
      budgetTelemetry: { providerRequestId: "gen-response-actual", requestCount: 1,
        inputTokens: 10, outputTokens: 5, runtimeMs: 100, costMicrousd: 2000,
        rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("reconciled");
  });

  it("retains the reservation when a Hermes response has no cost verdict", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      resultJson: { result: "Finished", apiCalls: 1, successfulProviderResponses: 1,
        usageTelemetryComplete: true, costStatus: null, costUnavailableReason: null,
        providerRequestIds: ["gen-response-actual"] },
      budgetTelemetry: { providerRequestId: "gen-response-actual", requestCount: 1,
        inputTokens: 10, outputTokens: 5, runtimeMs: 100, costMicrousd: 2000,
        rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("retained_missing_telemetry");
  });

  it("retains the reservation when Hermes reports no provider calls despite nominal budget telemetry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model",
      resultJson: { result: "Finished", apiCalls: 0, successfulProviderResponses: 0,
        usageTelemetryComplete: true, costStatus: null, costUnavailableReason: null,
        providerRequestIds: [] },
      budgetTelemetry: { providerRequestId: "gen-nonexistent", requestCount: 1,
        inputTokens: 10, outputTokens: 5, runtimeMs: 100, costMicrousd: 2000,
        rateCardVersion: "test-v1" },
    }));
    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [reservation] = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservation?.status).toBe("retained_missing_telemetry");
  });

  it("does not schedule a rollover without a durable execution checkpoint", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Session rollover required",
      errorCode: SESSION_ROLLOVER_WAKE_REASON,
      clearSession: true,
      summary: "Checkpointed work; verification remains.",
      provider: "test",
      model: "test-model",
      resultJson: { turn_exit_reason: SESSION_ROLLOVER_WAKE_REASON },
    }));

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const scheduled = await db
      .select({ reason: heartbeatRuns.scheduledRetryReason })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.scheduledRetryReason, SESSION_ROLLOVER_RETRY_REASON),
        ),
      );
    expect(scheduled).toEqual([]);
  });

  it("starts one fresh rollover session and rejects the unchanged capsule before another run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await db
      .update(issues)
      .set({
        description: [
          "Create the project-shared architecture graph model and scanner.",
          "",
          "Acceptance: preserve unrelated work and attach exact evidence.",
        ].join("\n"),
      })
      .where(eq(issues.id, issueId));
    const rolloverResult = () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Session rollover required",
      errorCode: SESSION_ROLLOVER_WAKE_REASON,
      clearSession: true,
      summary: "Checkpointed work; verification remains.",
      provider: "test",
      model: "test-model",
      resultJson: {
        turn_exit_reason: SESSION_ROLLOVER_WAKE_REASON,
        executionCheckpoint: validExecutionCheckpoint(),
      },
      budgetTelemetry: {
        providerRequestId: randomUUID(),
        requestCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        runtimeMs: 100,
        costMicrousd: 1,
        rateCardVersion: "test-v1",
      },
    });
    mockAdapterExecute.mockClear();
    mockAdapterExecute
      .mockImplementationOnce(async () => rolloverResult())
      .mockImplementationOnce(async () => rolloverResult());

    const inheritedFingerprint = await loadIssueTaskStateFingerprint({
      db,
      companyId,
      issueId,
    });
    expect(
      await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "external_chat_message",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          wakeReason: "External chat message received",
          executionContinuation: {
            taskStateCapsule: {
              hash: "inherited-from-an-older-rollover-chain",
              stateFingerprint: inheritedFingerprint,
            },
          },
        },
        requestedByActorType: "system",
        requestedByActorId: "test",
      }),
    ).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [scheduledRollover] = await db
      .select({ scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.scheduledRetryReason, SESSION_ROLLOVER_RETRY_REASON),
        ),
      );
    expect(scheduledRollover?.scheduledRetryAt).toBeInstanceOf(Date);
    await heartbeat.promoteDueScheduledRetries(
      new Date(scheduledRollover!.scheduledRetryAt!.getTime() + 1),
    );
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    const rolloverContext = mockAdapterExecute.mock.calls[1]?.[0];
    expect(rolloverContext?.runtime?.sessionId).toBeNull();
    expect(rolloverContext?.context?.wakeReason).toBe(
      SESSION_ROLLOVER_WAKE_REASON,
    );
    expect(
      rolloverContext?.executionContinuation?.coverage.kind,
    ).toBe("bounded_task_capsule");
    const runs = await db
      .select({
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(2);
    const [persistedRollover] = runs.filter(
      (run) => run.scheduledRetryReason === SESSION_ROLLOVER_RETRY_REASON,
    );
    expect(persistedRollover).toBeDefined();
    expect(
      (persistedRollover?.contextSnapshot as { executionContinuation?: unknown })
        ?.executionContinuation,
    ).toMatchObject({
      taskStateCapsule: rolloverContext?.executionContinuation?.taskStateCapsule,
      coverage: { kind: "bounded_task_capsule" },
    });
  });

  it("does not misclassify a pre-provider session rollover as missing telemetry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockClear();
    mockAdapterExecute
      .mockImplementationOnce(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Session rollover required",
        errorCode: SESSION_ROLLOVER_WAKE_REASON,
        clearSession: true,
        provider: "openai-codex",
        model: "test-model",
        resultJson: {
          turn_exit_reason: SESSION_ROLLOVER_WAKE_REASON,
          executionCheckpoint: validExecutionCheckpoint(),
          apiCalls: 0,
          successfulProviderResponses: 0,
          providerRequestIds: [],
          usageTelemetryComplete: false,
        },
      }))
      .mockImplementationOnce(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "openai-codex",
        model: "test-model",
        resultJson: {
          result: "Completed after fresh-session rollover",
          provider: "openai-codex",
          billingType: "subscription",
          budgetTelemetryComplete: true,
          costStatus: "included",
          costUnavailableReason: null,
          cost_usd: 0,
          apiCalls: 1,
          successfulProviderResponses: 1,
          providerRequestIds: ["rollover-success-request"],
          usageTelemetryComplete: true,
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        usageBasis: "per_run" as const,
        budgetTelemetry: {
          providerRequestId: "rollover-success-request",
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 5,
          runtimeMs: 100,
          costMicrousd: 0,
          rateCardVersion: "test-v1",
        },
      }));

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db.select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(heartbeatRuns.createdAt);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      status: "failed",
      errorCode: SESSION_ROLLOVER_WAKE_REASON,
    });
    expect(runs[1]).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: SESSION_ROLLOVER_RETRY_REASON,
    });

    const reservations = await db.select({ status: autonomousBudgetReservations.status })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.companyId, companyId))
      .orderBy(autonomousBudgetReservations.createdAt);
    expect(reservations[0]?.status).toBe("released");

    await db.update(heartbeatRuns).set({ processPid: null, processGroupId: null })
      .where(eq(heartbeatRuns.id, runs[0]!.id));
    await heartbeat.promoteDueScheduledRetries(
      new Date(runs[1]!.scheduledRetryAt!.getTime() + 1),
    );
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [completedRollover] = await db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runs[1]!.id));
    expect(completedRollover?.status).toBe("succeeded");
  });

  it("releases a verified pre-provider skill conflict without scheduling a retry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Managed skill target is occupied",
      errorCode: "skill_ownership_conflict",
      executionRecovery: {
        kind: "bootstrap" as const,
        providerWorkStarted: false as const,
      },
      retryHint: "operator_action_required" as const,
      resultJson: {
        executionRecovery: {
          kind: "bootstrap" as const,
          providerWorkStarted: false as const,
        },
        retryHint: "operator_action_required",
      },
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "skill_ownership_conflict",
        retryOfRunId: null,
      }),
    ]);

    const reservations = await db
      .select({
        status: autonomousBudgetReservations.status,
        providerActivityOccurred: autonomousBudgetReservations.providerActivityOccurred,
        providerRequestId: autonomousBudgetReservations.providerRequestId,
        actualRequestCount: autonomousBudgetReservations.actualRequestCount,
        actualInputTokens: autonomousBudgetReservations.actualInputTokens,
        actualOutputTokens: autonomousBudgetReservations.actualOutputTokens,
        actualCostMicrousd: autonomousBudgetReservations.actualCostMicrousd,
      })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservations).toEqual([
      {
        status: "released",
        providerActivityOccurred: false,
        providerRequestId: null,
        actualRequestCount: null,
        actualInputTokens: null,
        actualOutputTokens: null,
        actualCostMicrousd: null,
      },
    ]);
  });

  it.each([
    {
      errorCode: "execution_input_budget_exceeded",
      budgetFailureReason: "cumulative_input_tokens_exceeded",
      expectedCode: "execution_input_budget_exceeded",
      explanation: "cumulative authorized execution input",
      forbiddenExplanation: /model context boundary/i,
    },
    {
      errorCode: "model_context_limit_exceeded",
      budgetFailureReason: "context_window_exceeded",
      expectedCode: "model_context_limit_exceeded",
      explanation: "provider request/model context boundary",
      forbiddenExplanation: /cumulative|execution.*exhaust|input budget exhaustion/i,
    },
    {
      errorCode: "context_budget_exceeded",
      budgetFailureReason: undefined,
      expectedCode: "legacy_budget_terminal_unclassified",
      explanation: "available recorded evidence does not support assigning a modern budget category",
      forbiddenExplanation: /execution.*exhaust|input budget exhaustion|model context.*exceed/i,
    },
  ])("preserves budget retry-suppression semantics for $expectedCode", async (testCase) => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: testCase.errorCode,
      contextSnapshot: { issueId },
      resultJson: {
        turn_exit_reason: testCase.errorCode,
        ...(testCase.budgetFailureReason === undefined
          ? {}
          : { budget_failure_reason: testCase.budgetFailureReason }),
      },
    });
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const decision = await heartbeat.scheduleBoundedRetry(runId);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));

    // Assert persisted facts and absence of successors even while the semantic regression is RED.
    expect(after.errorCode).toBe(before.errorCode);
    expect(after.resultJson).toEqual(before.resultJson);
    expect(after.resultJson?.budget_failure_reason).toBe(before.resultJson?.budget_failure_reason);
    expect(successors.map((run) => run.id)).toEqual([runId]);
    expect(wakes).toEqual([]);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ outcome: "not_scheduled", errorCode: testCase.expectedCode });
    expect(decision).toHaveProperty("reason", expect.stringContaining(testCase.explanation));
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain(testCase.explanation);
    expect(events[0].payload).toMatchObject({ errorCode: testCase.expectedCode, retryDisposition: "non_retryable" });
    expect(events[0].message).not.toMatch(testCase.forbiddenExplanation);
    expect("reason" in decision ? decision.reason : "").not.toMatch(testCase.forbiddenExplanation);
  });

  it("settles attributed execution-input exhaustion without scheduling a retry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Hermes reported a failed run",
      errorCode: "execution_input_budget_exceeded",
      provider: "openai-codex",
      model: "test-model",
      usage: { inputTokens: 29_729, outputTokens: 634 },
      usageBasis: "per_run" as const,
      budgetTelemetry: {
        providerRequestId: "phase9-request-1",
        requestCount: 3,
        inputTokens: 29_729,
        outputTokens: 634,
        runtimeMs: 90_000,
        costMicrousd: 0,
        rateCardVersion: "subscription",
      },
      resultJson: {
        result: "",
        provider: "openai-codex",
        billingType: "subscription",
        budgetTelemetryComplete: true,
        costStatus: "included",
        costUnavailableReason: null,
        cost_usd: 0,
        apiCalls: 3,
        successfulProviderResponses: 3,
        providerRequestIds: [
          "phase9-request-1",
          "phase9-request-2",
          "phase9-request-3",
        ],
        usageTelemetryComplete: true,
        turn_exit_reason: "execution_input_budget_exceeded",
        budgetFailureReason: "cumulative_input_tokens_exceeded",
      },
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toEqual([
      {
        status: "failed",
        errorCode: "execution_input_budget_exceeded",
        retryOfRunId: null,
      },
    ]);

    const reservations = await db
      .select({
        status: autonomousBudgetReservations.status,
        providerActivityOccurred: autonomousBudgetReservations.providerActivityOccurred,
        providerRequestId: autonomousBudgetReservations.providerRequestId,
        actualRequestCount: autonomousBudgetReservations.actualRequestCount,
        actualInputTokens: autonomousBudgetReservations.actualInputTokens,
        actualOutputTokens: autonomousBudgetReservations.actualOutputTokens,
        actualCostMicrousd: autonomousBudgetReservations.actualCostMicrousd,
      })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservations).toEqual([
      {
        status: "reconciled",
        providerActivityOccurred: true,
        providerRequestId: "phase9-request-1",
        actualRequestCount: 3,
        actualInputTokens: 29_729,
        actualOutputTokens: 634,
        actualCostMicrousd: 0,
      },
    ]);
  });

  it("settles attributed no-progress usage without scheduling a retry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Hermes reported a failed run",
      errorCode: "no_progress",
      retryHint: "non_retryable" as const,
      provider: "openai-codex",
      model: "test-model",
      usage: { inputTokens: 12_000, outputTokens: 500 },
      usageBasis: "per_run" as const,
      budgetTelemetry: {
        providerRequestId: "no-progress-request-1",
        requestCount: 2,
        inputTokens: 12_000,
        outputTokens: 500,
        runtimeMs: 45_000,
        costMicrousd: 0,
        rateCardVersion: "subscription",
      },
      resultJson: {
        result: "",
        provider: "openai-codex",
        billingType: "subscription",
        budgetTelemetryComplete: true,
        costStatus: "included",
        costUnavailableReason: null,
        cost_usd: 0,
        apiCalls: 2,
        successfulProviderResponses: 2,
        providerRequestIds: ["no-progress-request-1", "no-progress-request-2"],
        usageTelemetryComplete: true,
        turn_exit_reason: "no_progress",
        retryHint: "non_retryable",
        progress: {
          provider_responses_since_baseline: 2,
          max_provider_responses_without_durable_progress: 2,
          workspace_changed: false,
          verification_commands: 0,
        },
      },
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toEqual([
      { status: "failed", errorCode: "no_progress", retryOfRunId: null },
    ]);

    const reservations = await db
      .select({
        status: autonomousBudgetReservations.status,
        actualRequestCount: autonomousBudgetReservations.actualRequestCount,
        actualInputTokens: autonomousBudgetReservations.actualInputTokens,
        actualOutputTokens: autonomousBudgetReservations.actualOutputTokens,
      })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservations).toEqual([
      {
        status: "reconciled",
        actualRequestCount: 2,
        actualInputTokens: 12_000,
        actualOutputTokens: 500,
      },
    ]);
  });

  it("fails a missing run-envelope policy without adapter execution or retry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await db
      .delete(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeId, issueId),
          eq(budgetPolicies.metric, "request_count"),
          eq(budgetPolicies.windowKind, "per_run"),
        ),
      );
    mockAdapterExecute.mockClear();

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        retryOfRunId: heartbeatRuns.retryOfRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toEqual([
      {
        status: "failed",
        errorCode: "autonomous_run_budget_policy_missing",
        retryOfRunId: null,
      },
    ]);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const reservations = await db
      .select({ id: autonomousBudgetReservations.id })
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reservations).toEqual([]);
  });

  it("persists no-progress outcomes and opens the circuit after the second unchanged run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db
      .select({
        workOutcome: heartbeatRuns.workOutcome,
        stateFingerprintBefore: heartbeatRuns.stateFingerprintBefore,
        stateFingerprintAfter: heartbeatRuns.stateFingerprintAfter,
        noProgressStreak: heartbeatRuns.noProgressStreak,
        continuityCircuitState: heartbeatRuns.continuityCircuitState,
        continuityCircuitOpenedAt: heartbeatRuns.continuityCircuitOpenedAt,
        continuityCircuitAlertedAt: heartbeatRuns.continuityCircuitAlertedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(heartbeatRuns.createdAt);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      workOutcome: "no_progress",
      noProgressStreak: 1,
      continuityCircuitState: "closed",
    });
    expect(runs[1]).toMatchObject({
      workOutcome: "no_progress",
      noProgressStreak: 2,
      continuityCircuitState: "open",
    });
    expect(runs[0]?.stateFingerprintBefore).toMatch(/^[a-f0-9]{32}$/);
    expect(runs[0]?.stateFingerprintAfter).toBe(runs[0]?.stateFingerprintBefore);
    expect(runs[1]?.stateFingerprintBefore).toBe(runs[0]?.stateFingerprintAfter);
    expect(runs[1]?.stateFingerprintAfter).toBe(runs[1]?.stateFingerprintBefore);
    expect(runs[1]?.continuityCircuitOpenedAt).toBeInstanceOf(Date);
    expect(runs[1]?.continuityCircuitAlertedAt).toBeInstanceOf(Date);
    const alertCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.continuity_circuit_opened"),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    expect(alertCount).toBe(1);

    expect(await assignmentWake(agentId, issueId)).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_circuit_open");
  });

  it("records budget exhaustion and opens the circuit without adapter execution", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await db
      .update(budgetPolicies)
      .set({ amount: 0 })
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeId, issueId),
          eq(budgetPolicies.metric, "billed_microusd"),
          eq(budgetPolicies.windowKind, "lifetime"),
        ),
      );
    mockAdapterExecute.mockClear();

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const run = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        workOutcome: heartbeatRuns.workOutcome,
        continuityCircuitState: heartbeatRuns.continuityCircuitState,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]);
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "budget_exhausted",
      workOutcome: "budget_exhausted",
      continuityCircuitState: "open",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("blocks provider dispatch and recovery while the provider circuit is open", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordAutonomousProviderCircuitOutcome(db, {
        companyId,
        provider: "codex_local",
        credentialIdentifierHash: null,
        runId: randomUUID(),
        outcome: "transient_failure",
      });
    }
    mockAdapterExecute.mockClear();

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        workOutcome: heartbeatRuns.workOutcome,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      errorCode: "provider_circuit_open",
      workOutcome: "blocked",
      resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(autonomousBudgetReservations)
        .where(eq(autonomousBudgetReservations.companyId, companyId)),
    ).toHaveLength(0);
  });

  it("closes a half-open provider circuit only after productive provider work", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    await recordAutonomousProviderCircuitOutcome(db, {
      companyId,
      provider: "codex_local",
      credentialIdentifierHash: null,
      runId: randomUUID(),
      outcome: "provider_quota",
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(issues)
        .set({ description: "Verified provider progress" })
        .where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Completed verified work.",
        provider: "test",
        model: "test-model",
        budgetTelemetry: {
          providerRequestId: randomUUID(),
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 5,
          runtimeMs: 100,
          costMicrousd: 1,
          rateCardVersion: "test-v1",
        },
      };
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.workOutcome, "productive"),
        ),
      );
    expect(run).toMatchObject({ status: "succeeded", workOutcome: "productive" });
    const [providerCircuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(providerCircuit).toMatchObject({
      state: "closed",
      consecutiveFailureCount: 0,
      lastSuccessRunId: run.id,
      probeRunId: null,
    });
  });

  it("reopens a nonproductive half-open probe without counting a provider failure", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const lastFailureRunId = randomUUID();
    await recordAutonomousProviderCircuitOutcome(db, {
      companyId,
      provider: "codex_local",
      credentialIdentifierHash: null,
      runId: lastFailureRunId,
      outcome: "provider_quota",
      now: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(run).toMatchObject({ status: "succeeded", workOutcome: "no_progress" });
    const [providerCircuit] = await db
      .select()
      .from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, companyId));
    expect(providerCircuit).toMatchObject({
      state: "open",
      consecutiveFailureCount: 1,
      lastFailureRunId,
      probeRunId: null,
    });
    expect(providerCircuit.nextProbeAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("skips event-free re-wakes after consecutive no-progress runs and admits them again on new input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const throttledWake = await assignmentWake(agentId, issueId);
    expect(throttledWake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("issue_rewake_throttled");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(2);
    expect(typeof heartbeatSkip?.nextAllowedAt).toBe("string");

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(2);

    // A board comment on the issue is new input: the next event-free wake is
    // admitted even though the streak has not been broken by a run.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

    const admittedWake = await assignmentWake(agentId, issueId);
    expect(admittedWake).not.toBeNull();
  });

  it("keeps an open unchanged-fingerprint circuit blocked after cooldown expiry", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const fingerprint = await loadIssueTaskStateFingerprint({ db, companyId, issueId });
    expect(fingerprint).toMatch(/^[a-f0-9]{32}$/);

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 600,
      workOutcome: "no_progress",
      stateFingerprintBefore: fingerprint!,
      stateFingerprintAfter: fingerprint!,
      noProgressStreak: 1,
    });
    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 300,
      workOutcome: "no_progress",
      stateFingerprintBefore: fingerprint!,
      stateFingerprintAfter: fingerprint!,
      noProgressStreak: 2,
      continuityCircuitState: "open",
      continuityCircuitOpenedAt: new Date(Date.now() - 300_000),
    });

    const wake = await assignmentWake(agentId, issueId);

    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_circuit_open");
  });

  it("closes an open circuit after a verified material fingerprint change", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const fingerprint = await loadIssueTaskStateFingerprint({ db, companyId, issueId });
    expect(fingerprint).toMatch(/^[a-f0-9]{32}$/);

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 300,
      workOutcome: "no_progress",
      stateFingerprintBefore: fingerprint!,
      stateFingerprintAfter: fingerprint!,
      noProgressStreak: 2,
      continuityCircuitState: "open",
      continuityCircuitOpenedAt: new Date(Date.now() - 300_000),
    });
    await db
      .update(issues)
      .set({ title: "Materially revised mission" })
      .where(eq(issues.id, issueId));

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
  });

  it("does not close an open circuit for activity without a verified fingerprint change", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const fingerprint = await loadIssueTaskStateFingerprint({ db, companyId, issueId });
    expect(fingerprint).toMatch(/^[a-f0-9]{32}$/);

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 600,
      workOutcome: "no_progress",
      stateFingerprintBefore: fingerprint!,
      stateFingerprintAfter: fingerprint!,
      noProgressStreak: 1,
    });
    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 300,
      workOutcome: "no_progress",
      stateFingerprintBefore: fingerprint!,
      stateFingerprintAfter: fingerprint!,
      noProgressStreak: 2,
      continuityCircuitState: "open",
      continuityCircuitOpenedAt: new Date(Date.now() - 300_000),
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

    const wake = await assignmentWake(agentId, issueId);

    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_circuit_open");
  });

  it("does not throttle system comment-driven wakes even during a no-progress streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(commentWake).not.toBeNull();
  });

  it("does not invoke the adapter for blocker-resolution wakes with no new state", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    const adapterCallsBefore = mockAdapterExecute.mock.calls.length;

    const blockerWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" },
      requestedByActorType: "system",
      requestedByActorId: "dependency-reconciler",
    });

    expect(blockerWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
    expect(mockAdapterExecute.mock.calls.length).toBe(adapterCallsBefore);
  });

  it("replays 247 unchanged blocker wakes without another fake-provider dispatch", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    mockAdapterExecute.mockClear();

    expect(await assignmentWake(agentId, issueId)).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);

    for (let attempt = 0; attempt < 247; attempt += 1) {
      const wake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: { issueId },
        contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" },
        requestedByActorType: "system",
        requestedByActorId: "dependency-reconciler",
      });
      expect(wake).toBeNull();
    }

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    const [skipped] = await db.select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, "issue_rewake_circuit_open")));
    expect(skipped?.count).toBe(247);
    const runs = await db.select({ continuityCircuitState: heartbeatRuns.continuityCircuitState })
      .from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(2);
    expect(runs.some((run) => run.continuityCircuitState === "open")).toBe(true);
    const calls = mockAdapterExecute.mock.calls;
    expect(calls.every(([context]) => context.autonomousBudgetEnvelope?.inputTokens === 64_000
      && context.autonomousBudgetEnvelope?.costMicrousd === 250_000)).toBe(true);
    const fakeResults = await Promise.all(mockAdapterExecute.mock.results.map((result) => result.value));
    expect(fakeResults.every((result) => result.budgetTelemetry.inputTokens <= 64_000)).toBe(true);
    expect(fakeResults.reduce((cost, result) => cost + result.budgetTelemetry.costMicrousd, 0))
      .toBeLessThanOrEqual(250_000);
    const [reserved] = await db.select({ cost: sql<number>`coalesce(sum(${autonomousBudgetReservations.reservedCostMicrousd}), 0)::int` })
      .from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.companyId, companyId));
    expect(reserved?.cost).toBeLessThanOrEqual(10_000_000);
  });

  it("keeps agent comments throttled without hiding genuinely new human input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const agentCommentId = randomUUID();
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    const throttledAgentCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: agentCommentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: agentCommentId,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });
    expect(throttledAgentCommentWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    const nextAgentCommentId = randomUUID();
    const admittedAfterHumanInput = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: nextAgentCommentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: nextAgentCommentId,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });
    expect(admittedAfterHumanInput).not.toBeNull();
  });

  it("keeps agent-authored explicit resume comments inside the no-progress cooldown", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    const resumeFromRunId = await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      sessionIdAfter: randomUUID(),
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentId = randomUUID();
    const resumeWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      payload: { issueId, commentId, resumeFromRunId, resumeIntent: true },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_reopened_via_comment",
        wakeCommentId: commentId,
        resumeIntent: true,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });

    expect(resumeWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("does not treat a user-attributed session selection as explicit resume intent", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const resumeFromRunId = await seedTerminalRun({ companyId, agentId, issueId,
      finishedSecondsAgo: 40, sessionIdAfter: randomUUID() });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const wake = await heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_reopened_via_comment",
      payload: { issueId, resumeFromRunId },
      contextSnapshot: { issueId, wakeReason: "issue_reopened_via_comment" },
      requestedByActorType: "user", requestedByActorId: "board-user",
    });

    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does not throttle the wake that follows a failed run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 70 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, status: "failed", finishedSecondsAgo: 10 });

    const recoveryWake = await assignmentWake(agentId, issueId);
    expect(recoveryWake).not.toBeNull();
  });

  it("does not throttle when a recent run produced issue-visible progress", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).not.toBeNull();
  });

  it("does not count progress on another issue toward the current issue", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Related follow-up",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: otherIssueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("counts a long-running session that finished inside the lookback window", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      startedSecondsAgo: 7 * 60 * 60,
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const wake = await assignmentWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });
});
