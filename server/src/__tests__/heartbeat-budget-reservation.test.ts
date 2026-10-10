import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  autonomousBudgetReservations,
  autonomousProviderCircuits,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  reconcileAutonomousBudget,
  reserveAutonomousBudget,
} from "../services/autonomous-budget-reservations.js";
import { settleSyntheticRetryPredecessor } from "./helpers/synthetic-retry-settlement.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("autonomous budget reservations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-reservation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCostBudgetFixture(amount: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reconciliation company",
      autonomousExecutionPaused: false,
      issuePrefix: `RC${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconciliation agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Budget reconciliation",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "task",
      scopeId: issueId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount,
      hardStopEnabled: true,
    });
    return { companyId, agentId, issueId };
  }

  it("does not round sub-cent reservations out of the budget race", async () => {
    const scope = await createCostBudgetFixture(1);
    await db
      .update(budgetPolicies)
      .set({ metric: "billed_microusd", amount: 1_000 })
      .where(eq(budgetPolicies.scopeId, scope.issueId));

    const reserve = () =>
      reserveAutonomousBudget(db, {
        ...scope,
        runId: randomUUID(),
        requested: {
          requestCount: 1,
          inputTokens: 1_000,
          outputTokens: 100,
          runtimeMs: 10_000,
          costMicrousd: 600,
        },
      });
    const results = await Promise.all([reserve(), reserve()]);

    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    expect(results.filter((result) => !result.admitted)).toHaveLength(1);
  });

  it("reconciles subscription resources with null monetary amounts under a fixed root request ceiling", async () => {
    const scope = await createCostBudgetFixture(500);
    const runId = randomUUID();
    const billingPolicy = {
      policyId: "codex-subscription-route",
      policyVersion: 1,
      policyDigest: "b".repeat(64),
      billingMode: "subscription_included" as const,
      credentialPrincipalId: "managed-account:codex-uat",
      maxRootChainProviderRequests: 12,
    };
    const reserved = await reserveAutonomousBudget(db, {
      ...scope,
      runId,
      provider: "openai-codex",
      model: "gpt-5.6-codex",
      billingPolicy,
      requested: { requestCount: 4, inputTokens: 25_000, outputTokens: 2_000, runtimeMs: 90_000 },
    });
    expect(reserved).toMatchObject({
      admitted: true,
      envelope: { requestCount: 4, costMicrousd: null },
    });
    const settlementEvidence = {
      source: "hermes_sqlite_transport_owner", contractVersion: 3, runId,
      digestSha256: "a".repeat(64), costBasis: "subscription_included",
      runtimeBasis: null, runtimeApplicability: "unavailable_by_route",
      billingMode: "subscription_included", routePolicyId: billingPolicy.policyId,
      routePolicyVersion: billingPolicy.policyVersion,
      routePolicyDigest: billingPolicy.policyDigest,
      credentialPrincipalId: billingPolicy.credentialPrincipalId,
      rootChainRequestLimit: billingPolicy.maxRootChainProviderRequests,
      tokenAccountingBasis: "provider_reported_tokens_v1",
    };
    expect(await reconcileAutonomousBudget(db, {
      ...scope, runId, providerActivityOccurred: true, providerRequestId: "response-sub-1",
      billingMode: "subscription_included",
      actual: { requestCount: 2, inputTokens: 200, outputTokens: 40, runtimeMs: null },
      settlementEvidence,
    })).toMatchObject({ status: "reconciled", settlementState: "partially_consumed" });
    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    expect(row).toMatchObject({
      billingMode: "subscription_included", monetaryApplicability: "not_applicable_per_request",
      routePolicyId: billingPolicy.policyId, routePolicyVersion: 1,
      rootChainRequestLimit: 12, reservedCostMicrousd: null, actualCostMicrousd: null,
      actualRequestCount: 2, actualInputTokens: 200, actualOutputTokens: 40,
      actualRuntimeMs: null,
    });
  });

  it("rejects null monetary reservations for metered billing at the database boundary", async () => {
    const scope = await createCostBudgetFixture(500);
    const runId = randomUUID();
    await expect(db.insert(autonomousBudgetReservations).values({
      ...scope,
      runId,
      chainRootRunId: runId,
      billingMode: "metered_currency",
      monetaryApplicability: "applicable_per_request",
      reservedCostCents: null,
      reservedCostMicrousd: null,
    })).rejects.toThrow();
  });

  it("does not reset or self-raise a subscription request ceiling on a successor", async () => {
    const scope = await createCostBudgetFixture(500);
    const rootRunId = randomUUID();
    const billingPolicy = {
      policyId: "codex-subscription-route",
      policyVersion: 1,
      policyDigest: "b".repeat(64),
      billingMode: "subscription_included" as const,
      credentialPrincipalId: "managed-account:codex-uat",
      maxRootChainProviderRequests: 5,
    };
    expect(await reserveAutonomousBudget(db, {
      ...scope, runId: rootRunId, billingPolicy,
      requested: { requestCount: 4, inputTokens: 100, outputTokens: 20, runtimeMs: 100 },
    })).toMatchObject({ admitted: true });
    await expect(reserveAutonomousBudget(db, {
      ...scope, runId: randomUUID(), previousRunId: rootRunId, billingPolicy,
      requested: { requestCount: 2, inputTokens: 10, outputTokens: 5, runtimeMs: 10 },
    })).rejects.toThrow("autonomous_budget_root_chain_request_limit_exceeded");
    await expect(reserveAutonomousBudget(db, {
      ...scope, runId: randomUUID(), previousRunId: rootRunId,
      billingPolicy: { ...billingPolicy, policyVersion: 2, maxRootChainProviderRequests: 6 },
      requested: { requestCount: 2, inputTokens: 10, outputTokens: 5, runtimeMs: 10 },
    })).rejects.toThrow("autonomous_budget_chain_billing_policy_mismatch");
  });

  it("rejects replaying a run reservation through a different scope", async () => {
    const original = await createCostBudgetFixture(500);
    const other = await createCostBudgetFixture(500);
    const runId = randomUUID();
    const requested = {
      requestCount: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      runtimeMs: 10_000,
      costMicrousd: 10_000,
    };
    await reserveAutonomousBudget(db, { ...original, runId, requested });

    await expect(reserveAutonomousBudget(db, {
      ...other,
      runId,
      requested,
    })).rejects.toThrow("autonomous_budget_reservation_scope_mismatch");
  });

  it("idempotently replays a verified zero-provider release", async () => {
    const scope = await createCostBudgetFixture(500);
    const runId = randomUUID();
    await reserveAutonomousBudget(db, {
      ...scope,
      runId,
      requested: {
        requestCount: 1,
        inputTokens: 1_000,
        outputTokens: 100,
        runtimeMs: 10_000,
        costMicrousd: 10_000,
      },
    });
    const reconciliation = {
      ...scope,
      runId,
      providerActivityOccurred: false,
      verifiedNoProviderActivity: true,
      providerRequestId: null,
      actual: null,
    };

    expect(await reconcileAutonomousBudget(db, reconciliation)).toEqual({
      status: "released",
      settlementState: "released_zero_usage",
      replayed: false,
    });
    expect(await reconcileAutonomousBudget(db, reconciliation)).toEqual({
      status: "released",
      settlementState: "released_zero_usage",
      replayed: true,
    });
  });

  it("denies an automatic successor before reservation when its predecessor is unsettled", async () => {
    const scope = await createCostBudgetFixture(500);
    const predecessorRunId = randomUUID();
    const successorRunId = randomUUID();
    const requested = {
      requestCount: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      runtimeMs: 10_000,
      costMicrousd: 10_000,
    };

    expect(await reserveAutonomousBudget(db, {
      ...scope,
      runId: predecessorRunId,
      requested,
    })).toMatchObject({ admitted: true });
    await db.insert(heartbeatRuns).values([
      {
        id: predecessorRunId,
        companyId: scope.companyId,
        agentId: scope.agentId,
        status: "failed",
        finishedAt: new Date(),
        contextSnapshot: { issueId: scope.issueId },
        resultJson: { conversationContinuation: "continue_conversation_v1" },
      },
      {
        id: successorRunId,
        companyId: scope.companyId,
        agentId: scope.agentId,
        status: "running",
        retryOfRunId: predecessorRunId,
        contextSnapshot: { issueId: scope.issueId },
      },
    ]);
    await db.update(issues).set({ executionRunId: successorRunId })
      .where(eq(issues.id, scope.issueId));

    const circuitsBefore = await db.select().from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, scope.companyId));
    await expect(reserveAutonomousBudget(db, {
      ...scope,
      runId: successorRunId,
      previousRunId: predecessorRunId,
      requested,
      provider: "test-provider",
      credentialIdentifierHash: "test-credential",
    })).rejects.toThrow("automatic_successor_launch_denied");
    expect(await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, successorRunId))).toHaveLength(0);
    expect(await db.select().from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, scope.companyId))).toEqual(circuitsBefore);
  });

  it("denies a settled automatic successor when retry authority is explicitly revoked", async () => {
    const scope = await createCostBudgetFixture(500);
    const predecessorRunId = randomUUID();
    const successorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "failed",
      finishedAt: new Date(),
      contextSnapshot: { issueId: scope.issueId },
      resultJson: {
        executionRecovery: { kind: "provider", providerWorkStarted: true },
        retryHint: "non_retryable",
      },
    });
    await settleSyntheticRetryPredecessor(db, predecessorRunId, {
      basis: "synthetic_completed_request",
    });
    await db.insert(heartbeatRuns).values({
      id: successorRunId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "running",
      retryOfRunId: predecessorRunId,
      contextSnapshot: { issueId: scope.issueId },
    });
    await db.update(issues).set({ executionRunId: successorRunId })
      .where(eq(issues.id, scope.issueId));

    const circuitsBefore = await db.select().from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, scope.companyId));
    await expect(reserveAutonomousBudget(db, {
      ...scope,
      runId: successorRunId,
      previousRunId: predecessorRunId,
      provider: "test-provider",
      credentialIdentifierHash: "test-credential",
    })).rejects.toThrow("automatic_successor_launch_denied");
    expect(await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, successorRunId))).toHaveLength(0);
    expect(await db.select().from(autonomousProviderCircuits)
      .where(eq(autonomousProviderCircuits.companyId, scope.companyId))).toEqual(circuitsBefore);
  });

  it("commits launch authorization with an eligible automatic successor reservation", async () => {
    const scope = await createCostBudgetFixture(500);
    const predecessorRunId = randomUUID();
    const successorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "failed",
      finishedAt: new Date(),
      contextSnapshot: { issueId: scope.issueId },
      resultJson: {
        executionRecovery: { kind: "provider", providerWorkStarted: true },
        errorFamily: "transient_upstream",
      },
    });
    await settleSyntheticRetryPredecessor(db, predecessorRunId, {
      basis: "synthetic_completed_request",
    });
    await db.insert(heartbeatRuns).values({
      id: successorRunId,
      companyId: scope.companyId,
      agentId: scope.agentId,
      status: "running",
      retryOfRunId: predecessorRunId,
      contextSnapshot: { issueId: scope.issueId },
    });
    await db.update(issues).set({ executionRunId: successorRunId })
      .where(eq(issues.id, scope.issueId));

    expect(await reserveAutonomousBudget(db, {
      ...scope,
      runId: successorRunId,
      previousRunId: predecessorRunId,
    })).toMatchObject({ admitted: true, replayed: false });
    expect(await db.select({ executionStage: heartbeatRuns.executionStage })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, successorRunId)))
      .toEqual([{ executionStage: "launch_authorized" }]);

    await db.update(heartbeatRuns).set({ executionStage: "launching" })
      .where(eq(heartbeatRuns.id, successorRunId));
    await expect(reserveAutonomousBudget(db, {
      ...scope,
      runId: successorRunId,
      previousRunId: predecessorRunId,
    })).rejects.toThrow("automatic_successor_launch_denied");
    expect(await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, successorRunId))).toHaveLength(1);
    expect(await db.select({ executionStage: heartbeatRuns.executionStage })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, successorRunId)))
      .toEqual([{ executionStage: "launching" }]);
  });

  it("atomically bounds concurrent continuations by one chain envelope", async () => {
    const scope = await createCostBudgetFixture(500);
    await db.insert(budgetPolicies).values([
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
    const rootRunId = randomUUID();
    const halfEnvelope = {
      requestCount: 4,
      inputTokens: 32_000,
      outputTokens: 4_000,
      runtimeMs: 150_000,
      costMicrousd: 125_000,
    };
    expect(await reserveAutonomousBudget(db, {
      ...scope,
      runId: rootRunId,
      requested: halfEnvelope,
    })).toMatchObject({ admitted: true });

    const continuations = await Promise.all([
      reserveAutonomousBudget(db, {
        ...scope,
        runId: randomUUID(),
        previousRunId: rootRunId,
        requested: halfEnvelope,
      }),
      reserveAutonomousBudget(db, {
        ...scope,
        runId: randomUUID(),
        previousRunId: rootRunId,
        requested: halfEnvelope,
      }),
    ]);

    expect(continuations.filter((result) => result.admitted)).toHaveLength(1);
    expect(continuations.filter((result) => !result.admitted)).toHaveLength(1);
    const reservations = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.companyId, scope.companyId));
    expect(new Set(reservations.map((row) => row.chainRootRunId))).toEqual(new Set([rootRunId]));
  });

  it("allocates only the remaining envelope to a continuation", async () => {
    const scope = await createCostBudgetFixture(500);
    await db.insert(budgetPolicies).values([
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
    const rootRunId = randomUUID();
    const halfEnvelope = {
      requestCount: 4,
      inputTokens: 32_000,
      outputTokens: 4_000,
      runtimeMs: 150_000,
      costMicrousd: 125_000,
    };
    await reserveAutonomousBudget(db, {
      ...scope,
      runId: rootRunId,
      requested: halfEnvelope,
    });

    const continuation = await reserveAutonomousBudget(db, {
      ...scope,
      runId: randomUUID(),
      previousRunId: rootRunId,
    });

    expect(continuation).toMatchObject({
      admitted: true,
      envelope: halfEnvelope,
    });
  });

  it("derives the maximum run envelope from five explicit per-run policies", async () => {
    const scope = await createCostBudgetFixture(500);
    await db.insert(budgetPolicies).values([
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId: scope.companyId, scopeType: "task", scopeId: scope.issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
    const runId = randomUUID();

    const result = await reserveAutonomousBudget(db, { ...scope, runId });

    expect(result.admitted).toBe(true);
    const row = await db
      .select()
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      reservedRequestCount: 8,
      reservedInputTokens: 64_000,
      reservedOutputTokens: 8_000,
      reservedRuntimeMs: 300_000,
      reservedCostMicrousd: 250_000,
    });
  });

  it("uses reconciled actual usage for the next admission", async () => {
    const scope = await createCostBudgetFixture(200);
    const firstRunId = randomUUID();
    await reserveAutonomousBudget(db, {
      ...scope,
      runId: firstRunId,
      requested: {
        requestCount: 1,
        inputTokens: 10_000,
        outputTokens: 1_000,
        runtimeMs: 60_000,
        costCents: 100,
      },
    });

    await reconcileAutonomousBudget(db, {
      ...scope,
      runId: firstRunId,
      providerActivityOccurred: true,
      providerRequestId: "req-reconciled-1",
      actual: {
        requestCount: 1,
        inputTokens: 8_000,
        outputTokens: 800,
        runtimeMs: 45_000,
        costCents: 40,
      },
    });
    const next = await reserveAutonomousBudget(db, {
      ...scope,
      runId: randomUUID(),
      requested: {
        requestCount: 1,
        inputTokens: 10_000,
        outputTokens: 1_000,
        runtimeMs: 60_000,
        costCents: 150,
      },
    });

    expect(next.admitted).toBe(true);
    const row = await db
      .select()
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, firstRunId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "reconciled",
      actualCostCents: 40,
      actualInputTokens: 8_000,
      providerRequestId: "req-reconciled-1",
    });
  });

  it("alerts once on verified prompt growth but not on replay or missing telemetry", async () => {
    const scope = await createCostBudgetFixture(1000);
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const missingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: secondRunId, companyId: scope.companyId,
      agentId: scope.agentId, status: "completed" });
    await db.insert(autonomousBudgetReservations).values([
      { ...scope, runId: firstRunId, provider: "openrouter", model: "test-model",
        status: "reconciled", actualRequestCount: 1, actualInputTokens: 10_000,
        actualOutputTokens: 100, actualRuntimeMs: 1000, actualCostMicrousd: 10_000,
        providerActivityOccurred: true, providerRequestId: "prompt-first", reconciledAt: new Date("2026-09-01T00:00:00Z") },
      { ...scope, runId: secondRunId, provider: "openrouter", model: "test-model" },
      { ...scope, runId: missingRunId, provider: "openrouter", model: "test-model" },
    ]);
    const input = { ...scope, runId: secondRunId, provider: "openrouter", model: "test-model",
      providerActivityOccurred: true, providerRequestId: "prompt-second",
      actual: { requestCount: 1, inputTokens: 35_000, outputTokens: 100,
        runtimeMs: 1000, costMicrousd: 20_000 } };
    expect(await reconcileAutonomousBudget(db, input)).toMatchObject({ status: "reconciled", replayed: false });
    expect(await reconcileAutonomousBudget(db, input)).toMatchObject({ status: "reconciled", replayed: true });
    expect(await reconcileAutonomousBudget(db, { ...input, runId: missingRunId,
      providerActivityOccurred: false, providerRequestId: null, actual: null }))
      .toMatchObject({ status: "retained_missing_telemetry" });
    const alerts = await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId));
    expect(alerts.filter((row) => row.action === "issue.continuity_prompt_growth"))
      .toMatchObject([{ runId: secondRunId, entityId: scope.issueId,
        details: { previousInputTokens: 10_000, actualInputTokens: 35_000 } }]);
    const orphanRunId = randomUUID();
    await db.insert(autonomousBudgetReservations).values({ ...scope, runId: orphanRunId,
      provider: "openrouter", model: "test-model" });
    const orphanInput = { ...input, runId: orphanRunId, providerRequestId: "prompt-orphan",
      actual: { ...input.actual, inputTokens: 80_000 } };
    expect(await reconcileAutonomousBudget(db, orphanInput))
      .toMatchObject({ status: "reconciled", replayed: false });
    expect(await reconcileAutonomousBudget(db, orphanInput))
      .toMatchObject({ status: "reconciled", replayed: true });
    const growthAlerts = (await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId)))
      .filter((row) => row.action === "issue.continuity_prompt_growth");
    expect(growthAlerts).toHaveLength(1);
    expect(growthAlerts[0]).toMatchObject({ runId: secondRunId });
    expect((await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, orphanRunId)))[0])
      .toMatchObject({ status: "reconciled", actualInputTokens: 80_000 });

    await db.update(activityLog).set({ createdAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(activityLog.id, growthAlerts[0].id));
    const laterRunId = randomUUID();
    await db.insert(autonomousBudgetReservations).values({ ...scope, runId: laterRunId,
      provider: "openrouter", model: "test-model" });
    await reconcileAutonomousBudget(db, { ...input, runId: laterRunId,
      providerRequestId: "prompt-later", actual: { ...input.actual, inputTokens: 170_000 } });
    const laterAlerts = (await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId)))
      .filter((row) => row.action === "issue.continuity_prompt_growth");
    expect(laterAlerts).toHaveLength(2);
    expect(laterAlerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: null, details: expect.objectContaining({
        sourceRunId: laterRunId, previousInputTokens: 80_000, actualInputTokens: 170_000,
      }) }),
    ]));
    const concurrentRunIds = [randomUUID(), randomUUID()];
    await db.insert(autonomousBudgetReservations).values(concurrentRunIds.map((runId) => ({
      ...scope, runId, provider: "openrouter", model: "test-model",
    })));
    const concurrent = await Promise.all(concurrentRunIds.map((runId, index) =>
      reconcileAutonomousBudget(db, { ...input, runId, providerRequestId: `prompt-parallel-${index}`,
        actual: { ...input.actual, inputTokens: index === 0 ? 350_000 : 720_000 } })));
    expect(concurrent.every((result) => result.status === "reconciled" && !result.replayed)).toBe(true);
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId)))
      .filter((entry) => entry.action === "issue.continuity_prompt_growth")).toHaveLength(2);
  });

  it("counts a verified overrun against the next admission", async () => {
    const scope = await createCostBudgetFixture(100);
    const runId = randomUUID();
    await reserveAutonomousBudget(db, {
      ...scope, runId,
      requested: { requestCount: 1, inputTokens: 100, outputTokens: 10,
        runtimeMs: 1_000, costCents: 60 },
    });
    await reconcileAutonomousBudget(db, {
      ...scope, runId, providerActivityOccurred: true,
      providerRequestId: "req-overrun-1",
      actual: { requestCount: 1, inputTokens: 100, outputTokens: 10,
        runtimeMs: 1_100, costCents: 110 },
    });
    const next = await reserveAutonomousBudget(db, {
      ...scope, runId: randomUUID(),
      requested: { requestCount: 1, inputTokens: 1, outputTokens: 1,
        runtimeMs: 1, costCents: 1 },
    });
    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    expect(row).toMatchObject({ status: "reconciled", actualCostCents: 110, actualRuntimeMs: 1_100 });
    expect(next).toMatchObject({ admitted: false, reason: "task_budget_exhausted" });
  });

  it("preserves the historical PHA-7 input overrun during idempotent settlement", async () => {
    const scope = await createCostBudgetFixture(1000);
    const runId = randomUUID();
    await reserveAutonomousBudget(db, {
      ...scope,
      runId,
      requested: {
        requestCount: 4,
        inputTokens: 25_000,
        outputTokens: 8_000,
        runtimeMs: 180_000,
        costMicrousd: 1,
      },
    });
    const reconciliation = {
      ...scope,
      runId,
      providerActivityOccurred: true,
      providerRequestId: "pha-7-request-1",
      actual: {
        requestCount: 3,
        inputTokens: 29_729,
        outputTokens: 634,
        runtimeMs: 90_000,
        costMicrousd: 0,
      },
    };

    expect(await reconcileAutonomousBudget(db, reconciliation)).toMatchObject({
      status: "reconciled",
      settlementState: "consumed_over_reservation",
      replayed: false,
    });
    expect(await reconcileAutonomousBudget(db, reconciliation)).toMatchObject({
      status: "reconciled",
      settlementState: "consumed_over_reservation",
      replayed: true,
    });

    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    expect(row).toMatchObject({
      reservedInputTokens: 25_000,
      actualInputTokens: 29_729,
      overrunInputTokens: 4_729,
      settlementState: "consumed_over_reservation",
    });
  });

  it("upgrades uncertain historical usage when authoritative telemetry is recovered", async () => {
    const scope = await createCostBudgetFixture(1000);
    const runId = randomUUID();
    await reserveAutonomousBudget(db, {
      ...scope,
      runId,
      requested: {
        requestCount: 4,
        inputTokens: 25_000,
        outputTokens: 8_000,
        runtimeMs: 180_000,
        costMicrousd: 1,
      },
    });
    await reconcileAutonomousBudget(db, {
      ...scope,
      runId,
      providerActivityOccurred: true,
      providerRequestId: null,
      actual: null,
    });

    const recovered = {
      ...scope,
      runId,
      providerActivityOccurred: true,
      providerRequestId: "pha-7-request-1",
      actual: {
        requestCount: 3,
        inputTokens: 29_729,
        outputTokens: 634,
        runtimeMs: 27_379,
        costMicrousd: 0,
      },
    };
    expect(await reconcileAutonomousBudget(db, recovered)).toEqual({
      status: "reconciled",
      settlementState: "consumed_over_reservation",
      replayed: false,
    });
    expect(await reconcileAutonomousBudget(db, recovered)).toEqual({
      status: "reconciled",
      settlementState: "consumed_over_reservation",
      replayed: true,
    });
    await expect(reconcileAutonomousBudget(db, {
      ...recovered,
      actual: { ...recovered.actual, inputTokens: 29_728 },
    })).rejects.toThrow("autonomous_budget_reconciliation_conflict");

    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    expect(row).toMatchObject({
      actualRequestCount: 3,
      actualInputTokens: 29_729,
      actualOutputTokens: 634,
      actualRuntimeMs: 27_379,
      overrunInputTokens: 4_729,
      settlementState: "consumed_over_reservation",
    });
  });

  it("retains the full reservation when provider telemetry is missing", async () => {
    const scope = await createCostBudgetFixture(200);
    const firstRunId = randomUUID();
    await reserveAutonomousBudget(db, {
      ...scope,
      runId: firstRunId,
      requested: {
        requestCount: 1,
        inputTokens: 10_000,
        outputTokens: 1_000,
        runtimeMs: 60_000,
        costCents: 100,
      },
    });

    await reconcileAutonomousBudget(db, {
      ...scope,
      runId: firstRunId,
      providerActivityOccurred: true,
      providerRequestId: null,
      actual: null,
    });
    const next = await reserveAutonomousBudget(db, {
      ...scope,
      runId: randomUUID(),
      requested: {
        requestCount: 1,
        inputTokens: 10_000,
        outputTokens: 1_000,
        runtimeMs: 60_000,
        costCents: 101,
      },
    });

    expect(next).toMatchObject({ admitted: false, reason: "task_budget_exhausted" });
    const row = await db
      .select()
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, firstRunId))
      .then((rows) => rows[0]);
    expect(row.status).toBe("retained_missing_telemetry");
    expect(row.actualCostCents).toBeNull();
  });

  it("enforces company-day requests and agent-day input tokens before insertion", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Layered budget company",
      autonomousExecutionPaused: false,
      issuePrefix: "LB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Layered budget agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Layered reservation",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values([
      {
        companyId,
        scopeType: "company",
        scopeId: companyId,
        metric: "request_count",
        windowKind: "calendar_day_utc",
        amount: 1,
        hardStopEnabled: true,
      },
      {
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "input_tokens",
        windowKind: "calendar_day_utc",
        amount: 10_000,
        hardStopEnabled: true,
      },
    ]);

    const first = await reserveAutonomousBudget(db, {
      companyId,
      agentId,
      issueId,
      runId: randomUUID(),
      requested: {
        requestCount: 1,
        inputTokens: 8_000,
        outputTokens: 500,
        runtimeMs: 30_000,
        costCents: 0,
      },
    });
    const second = await reserveAutonomousBudget(db, {
      companyId,
      agentId,
      issueId,
      runId: randomUUID(),
      requested: {
        requestCount: 1,
        inputTokens: 3_000,
        outputTokens: 500,
        runtimeMs: 30_000,
        costCents: 0,
      },
    });

    expect(first.admitted).toBe(true);
    expect(second).toMatchObject({ admitted: false, reason: "agent_budget_exhausted" });
  });

  it("admits only one of two concurrent reservations competing for the remaining task budget", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Budget race company",
      autonomousExecutionPaused: false,
      issuePrefix: "BR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budgeted agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Atomic reservation race",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "task",
      scopeId: issueId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      hardStopEnabled: true,
    });

    const reserve = (runId: string) =>
      reserveAutonomousBudget(db, {
        companyId,
        agentId,
        issueId,
        runId,
        requested: {
          requestCount: 1,
          inputTokens: 10_000,
          outputTokens: 1_000,
          runtimeMs: 60_000,
          costCents: 60,
        },
      });
    const results = await Promise.all([reserve(randomUUID()), reserve(randomUUID())]);

    expect(results.filter((result) => result.admitted)).toHaveLength(1);
    expect(results.filter((result) => !result.admitted)).toHaveLength(1);
    const rows = await db
      .select()
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "reserved",
      reservedCostCents: 60,
      reservedRequestCount: 1,
      reservedInputTokens: 10_000,
      reservedOutputTokens: 1_000,
      reservedRuntimeMs: 60_000,
    });
  });

  it("audits rapid committed-cost velocity once without claiming provider spend", async () => {
    const scope = await createCostBudgetFixture(1000);
    const [policy] = await db.insert(budgetPolicies).values({ companyId: scope.companyId,
      scopeType: "company", scopeId: scope.companyId, metric: "billed_microusd",
      windowKind: "calendar_day_utc", amount: 1_000_000,
    }).returning({ id: budgetPolicies.id });
    const reserve = (runId: string, costMicrousd: number) => reserveAutonomousBudget(db, {
      ...scope, runId, requested: { requestCount: 1, inputTokens: 1_000,
        outputTokens: 100, runtimeMs: 1_000, costMicrousd },
    });
    await reserve(randomUUID(), 100_000);
    const second = randomUUID();
    await reserve(second, 200_000);
    await reserve(second, 200_000);
    await reserve(randomUUID(), 100_000);
    const alerts = (await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId)))
      .filter((row) => row.action === "company.continuity_cost_velocity");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ entityId: scope.companyId,
      details: { policyId: policy.id, sourceRunId: second, committedCostMicrousd: 300_000,
        dailyLimitMicrousd: 1_000_000, windowMinutes: 15 } });
  });

  it("emits each crossed utilization threshold once per policy window", async () => {
    const scope = await createCostBudgetFixture(100);
    const policy = await db
      .select({ id: budgetPolicies.id })
      .from(budgetPolicies)
      .where(eq(budgetPolicies.scopeId, scope.issueId))
      .then((rows) => rows[0]);

    for (const costCents of [50, 25, 15, 10]) {
      const result = await reserveAutonomousBudget(db, {
        ...scope,
        runId: randomUUID(),
        requested: {
          requestCount: 1,
          inputTokens: 1,
          outputTokens: 1,
          runtimeMs: 1,
          costCents,
        },
      });
      expect(result.admitted).toBe(true);
    }

    const incidents = await db
      .select({ thresholdType: budgetIncidents.thresholdType })
      .from(budgetIncidents)
      .where(eq(budgetIncidents.policyId, policy.id));
    expect(incidents.map((incident) => incident.thresholdType).sort()).toEqual([
      "100_percent",
      "50_percent",
      "75_percent",
      "90_percent",
    ]);

    const replay = await reserveAutonomousBudget(db, {
      ...scope,
      runId: randomUUID(),
      requested: {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        runtimeMs: 0,
        costCents: 0,
      },
    });
    expect(replay.admitted).toBe(true);
    const count = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(budgetIncidents)
      .where(eq(budgetIncidents.policyId, policy.id))
      .then((rows) => rows[0]?.count ?? 0);
    expect(count).toBe(4);
  });
});
