import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  agents,
  agentWakeupRequests,
  automaticSuccessorIntents,
  autonomousBudgetReservations,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { seedSyntheticCompanyBudgets } from "./helpers/synthetic-autonomous-budgets.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import type {
  TerminalRunDispositionInput,
  TerminalRunDispositionResult,
} from "../services/terminal-run-disposition.js";
import type { Db } from "@paperclipai/db";

const terminalFault = vi.hoisted(() => ({
  armPostFinalizationFailure: false,
  executeCalls: 0,
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskRun: vi.fn() };
});

// Wraps the real terminal service so every test exercises genuine
// transactional writes; the rollback test arms a one-shot failure that fires
// after a successful finalization but still inside the heartbeat transaction.
vi.mock("../services/terminal-run-disposition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/terminal-run-disposition.js")>();
  return {
    ...actual,
    terminalRunDispositionService: (db: Db) => {
      const svc = actual.terminalRunDispositionService(db);
      return {
        ...svc,
        finalizeTerminalRunDisposition: async (
          tx: Db,
          input: TerminalRunDispositionInput,
        ): Promise<TerminalRunDispositionResult | null> => {
          const result = await svc.finalizeTerminalRunDisposition(tx, input);
          if (terminalFault.armPostFinalizationFailure && result?.outcome === "finalized") {
            terminalFault.armPostFinalizationFailure = false;
            throw new Error("forced terminal finalization transaction failure");
          }
          return result;
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "terminal_disposition_test";
const CONTINUATION_WAKE_REASON = "issue_continuation_needed";
const DEPENDENCY_WAKE_REASON = "issue_blockers_resolved";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat terminal disposition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Fixture = {
  companyId: string;
  agentId: string;
  issueId: string;
};

// The adapter behavior for the current test. It runs inside the real
// executeRun path, so it can build the bound version-2 disposition with the
// server-assigned run id — exactly what the Hermes adapter ships after
// normalizing the model's wire envelope with trusted execution context.
let adapterBehavior: (ctx: { runId: string }) => Promise<AdapterExecutionResult>;

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat terminal run disposition integration", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;
  let fixture!: Fixture;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-disposition-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      // Test-only seam (forbidden outside NODE_ENV=test): accept the stub
      // adapter's telemetry as verified budget evidence.
      verifyBudgetEvidenceForTest: (result) => result.budgetTelemetry ?? null,
    });
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-disp-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        terminalFault.executeCalls += 1;
        return adapterBehavior({ runId: ctx.runId });
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 90_000);

  beforeEach(() => {
    terminalFault.armPostFinalizationFailure = false;
    terminalFault.executeCalls = 0;
    // Default behavior: a successful run whose adapter emits a bound v2
    // complete disposition plus the budget telemetry the settlement path
    // reconciles into a consumed reservation.
    adapterBehavior = async ({ runId }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Task complete",
      resultJson: {
        runDisposition: {
          version: 2,
          kind: "complete",
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          agentId: fixture.agentId,
          runId,
          workspaceId: null,
        },
      },
      budgetTelemetry: {
        providerRequestId: "req_terminal_disposition_test",
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        runtimeMs: 2_000,
        costMicrousd: 500,
      },
    });
  });

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // cleanup truncates; a late write would race the truncate.
    await drainHeartbeatRunsToQuiescence(db, heartbeat).catch(() => {});
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "heartbeat_run_events",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "automatic_successor_intents",
        "autonomous_budget_reservations",
        "autonomous_provider_circuits",
        "budget_incidents",
        "budget_policies",
        "issue_relations",
        "issue_comments",
        "heartbeat_runs",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedFixture(overrides: { issueStatus?: string } = {}): Promise<Fixture> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal heartbeat",
      issuePrefix: `TH${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      autonomousExecutionPaused: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TerminalAgent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Finalize through the heartbeat",
      status: overrides.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await seedSyntheticCompanyBudgets(db, companyId);
    fixture = { companyId, agentId, issueId };
    return fixture;
  }

  async function invokeAndDrain() {
    const run = await heartbeat.invoke(fixture.agentId, "on_demand", { issueId: fixture.issueId }, "manual");
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return { run: run!, finished };
  }

  const readIssue = (issueId: string) =>
    db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);

  const readIntents = (companyId: string) =>
    db
      .select()
      .from(automaticSuccessorIntents)
      .where(eq(automaticSuccessorIntents.companyId, companyId));

  const continuationWakes = (companyId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, CONTINUATION_WAKE_REASON),
        ),
      );

  const dependencyWakes = (companyId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, DEPENDENCY_WAKE_REASON),
        ),
      );

  const successorRuns = (runId: string) =>
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));

  it("atomically marks the exact issue done when a bound complete arrives", async () => {
    await seedFixture();
    const { run, finished } = await invokeAndDrain();

    expect(finished?.status).toBe("succeeded");
    expect(terminalFault.executeCalls).toBe(1);

    const issue = await readIssue(fixture.issueId);
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).not.toBeNull();

    // The budget reservation reconciled durably before finalization.
    const [reservation] = await db
      .select()
      .from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, run.id));
    expect(reservation).toMatchObject({ status: "reconciled", settlementState: "partially_consumed" });
    expect(reservation?.reconciledAt).not.toBeNull();

    // Read back through the heartbeat service: the issue terminal state and
    // the run state are both durable.
    const readBackRun = await heartbeat.getRun(run.id);
    expect(readBackRun?.status).toBe("succeeded");
    expect((await readIssue(fixture.issueId))?.status).toBe("done");
  }, 30_000);

  it("records exactly one terminal intent and zero productive successors", async () => {
    await seedFixture();
    const { run } = await invokeAndDrain();

    const intents = await readIntents(fixture.companyId);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      predecessorRunId: run.id,
      kind: "terminal",
      status: "materialized",
      reason: "run_disposition_complete",
      denialReason: null,
    });

    // A terminal decision never enters the productive-successor path: no
    // continuation wake, no successor run, no second adapter call.
    expect(await continuationWakes(fixture.companyId)).toHaveLength(0);
    expect(await successorRuns(run.id)).toHaveLength(0);
    expect(terminalFault.executeCalls).toBe(1);
    const companyRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, fixture.companyId));
    expect(companyRuns).toHaveLength(1);
  }, 30_000);

  it("replays a committed terminal intent through the stranded sweep exactly once", async () => {
    await seedFixture();
    const runId = randomUUID();
    // Simulate the crash window the backstop exists for: a terminal intent
    // committed (materialized) while the issue is still in_progress.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      status: "succeeded",
      finishedAt: new Date(),
      contextSnapshot: { issueId: fixture.issueId },
      resultJson: {
        runDisposition: {
          version: 2,
          kind: "complete",
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          agentId: fixture.agentId,
          runId,
          workspaceId: null,
        },
      },
    });
    await db.insert(automaticSuccessorIntents).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      predecessorRunId: runId,
      chainRootRunId: runId,
      kind: "terminal",
      status: "materialized",
      reason: "run_disposition_complete",
      authorizationBinding: {
        issueId: fixture.issueId,
        agentId: fixture.agentId,
        workspaceId: null,
      },
      policyVersion: 1,
    });

    // Concurrent sweeps agree on exactly one terminal decision.
    const [sweepA, sweepB] = await Promise.all([
      heartbeat.reconcileStrandedAssignedIssues(),
      heartbeatService(db, { runtimeEnv: {} }).reconcileStrandedAssignedIssues(),
    ]);
    expect(sweepA.terminalFinalizationReplayed + sweepB.terminalFinalizationReplayed).toBeGreaterThanOrEqual(1);

    const issue = await readIssue(fixture.issueId);
    expect(issue?.status).toBe("done");
    const completedAt = issue?.completedAt;
    expect(completedAt).not.toBeNull();

    // The sweep replayed committed authority only: no continuation wake, no
    // successor run, no provider call, no duplicate intent.
    expect(await readIntents(fixture.companyId)).toHaveLength(1);
    expect(await continuationWakes(fixture.companyId)).toHaveLength(0);
    expect(await successorRuns(runId)).toHaveLength(0);
    expect(terminalFault.executeCalls).toBe(0);

    // Repeating the sweep is idempotent: no further mutation.
    const again = await heartbeat.reconcileStrandedAssignedIssues();
    expect(again.terminalFinalizationReplayed).toBe(0);
    expect((await readIssue(fixture.issueId))?.completedAt?.getTime()).toBe(completedAt?.getTime());
    expect(await readIntents(fixture.companyId)).toHaveLength(1);
  }, 30_000);

  it("rolls back the issue transition and the intent when the transaction fails", async () => {
    await seedFixture();
    terminalFault.armPostFinalizationFailure = true;

    const run = await heartbeat.invoke(fixture.agentId, "on_demand", { issueId: fixture.issueId }, "manual");
    expect(run).not.toBeNull();
    await waitForRunToFinish(heartbeat, run!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat).catch(() => {});

    // Both writes rolled back: the issue is untouched and no terminal intent
    // survives. The provider was called exactly once and is never replayed.
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    expect(await readIntents(fixture.companyId)).toHaveLength(0);
    expect(terminalFault.executeCalls).toBe(1);
    expect(await continuationWakes(fixture.companyId)).toHaveLength(0);
    expect(await successorRuns(run!.id)).toHaveLength(0);
  }, 30_000);

  it("denies a disposition bound to a different run with zero mutation", async () => {
    await seedFixture();
    adapterBehavior = async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Task complete",
      resultJson: {
        runDisposition: {
          version: 2,
          kind: "complete",
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          agentId: fixture.agentId,
          // Binding violation: the payload claims a run that is not this run.
          runId: randomUUID(),
          workspaceId: null,
        },
      },
      budgetTelemetry: {
        providerRequestId: "req_terminal_disposition_test",
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        runtimeMs: 2_000,
        costMicrousd: 500,
      },
    });

    const { run } = await invokeAndDrain();

    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    const intents = await readIntents(fixture.companyId);
    expect(intents.filter((intent) => intent.kind === "terminal")).toHaveLength(0);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: "denied",
      denialReason: "authorization_binding_mismatch",
    });
    expect(await continuationWakes(fixture.companyId)).toHaveLength(0);
    expect(await successorRuns(run.id)).toHaveLength(0);
  }, 30_000);

  it("denies a bound complete with an unsettled budget reservation with zero mutation", async () => {
    await seedFixture();
    // Telemetry over the reserved envelope reconciles as
    // "consumed_over_reservation", which is not a durable consumed/zero
    // settlement — the terminal authority must fail closed.
    adapterBehavior = async ({ runId }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Task complete",
      resultJson: {
        runDisposition: {
          version: 2,
          kind: "complete",
          companyId: fixture.companyId,
          issueId: fixture.issueId,
          agentId: fixture.agentId,
          runId,
          workspaceId: null,
        },
      },
      budgetTelemetry: {
        providerRequestId: "req_terminal_disposition_overrun",
        requestCount: 99,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        runtimeMs: 9_000_000,
        costMicrousd: 9_000_000,
      },
    });

    const { run } = await invokeAndDrain();

    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    const intents = await readIntents(fixture.companyId);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: "terminal",
      status: "denied",
      denialReason: "terminal_settlement_unreconciled",
    });
    expect(await continuationWakes(fixture.companyId)).toHaveLength(0);
    expect(await successorRuns(run.id)).toHaveLength(0);
  }, 30_000);

  it("never mutates or wakes a different task than the bound one", async () => {
    await seedFixture();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: fixture.companyId,
      title: "Unrelated in-progress work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: fixture.agentId,
      responsibleUserId: "responsible-user",
    });
    // The adapter emits a disposition bound to the OTHER issue while the run
    // executes on the fixture issue — a cross-task authority claim.
    adapterBehavior = async ({ runId }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Task complete",
      resultJson: {
        runDisposition: {
          version: 2,
          kind: "complete",
          companyId: fixture.companyId,
          issueId: otherIssueId,
          agentId: fixture.agentId,
          runId,
          workspaceId: null,
        },
      },
      budgetTelemetry: {
        providerRequestId: "req_terminal_disposition_test",
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        runtimeMs: 2_000,
        costMicrousd: 500,
      },
    });

    const { run } = await invokeAndDrain();

    // Neither task moved: the bound target was not mutated and the executing
    // issue was not completed by a foreign binding.
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    expect((await readIssue(otherIssueId))?.status).toBe("in_progress");
    const intents = await readIntents(fixture.companyId);
    expect(intents.filter((intent) => intent.kind === "terminal")).toHaveLength(0);
    expect(intents.filter((intent) => intent.status === "materialized")).toHaveLength(0);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, fixture.companyId));
    expect(wakes.filter((wake) => wake.reason === CONTINUATION_WAKE_REASON)).toHaveLength(0);
    expect(
      wakes.filter((wake) => (wake.payload as Record<string, unknown> | null)?.issueId === otherIssueId),
    ).toHaveLength(0);
    expect(await successorRuns(run.id)).toHaveLength(0);
  }, 30_000);

  it("wakes a blocked dependent only after the blocker commits done", async () => {
    await seedFixture();
    const dependentAgentId = randomUUID();
    const dependentIssueId = randomUUID();
    await db.insert(agents).values({
      id: dependentAgentId,
      companyId: fixture.companyId,
      name: "DependentAgent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: dependentIssueId,
      companyId: fixture.companyId,
      title: "Blocked dependent",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: dependentAgentId,
      responsibleUserId: "responsible-user",
      blockedTransitionAt: new Date(),
    });
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });

    // Before any committed completion, the dependency mechanism does not wake.
    const early = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fixture.companyId });
    expect(early.healed).toBe(0);
    expect(await dependencyWakes(fixture.companyId)).toHaveLength(0);

    const { run } = await invokeAndDrain();
    expect((await readIssue(fixture.issueId))?.status).toBe("done");

    // After the terminal transaction commits, the existing dependency
    // mechanism (delivered via the issue update's post-commit actions, drained
    // by the heartbeat only after commit) wakes the eligible dependent exactly
    // once. The terminal decision itself claimed no successor intent.
    const wakes = await dependencyWakes(fixture.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: dependentAgentId });
    expect((wakes[0]!.payload as Record<string, unknown>)?.issueId).toBe(dependentIssueId);

    // The reconciliation backstop sees the in-flight wake and stays
    // idempotent: no second wake for the same ready state.
    const again = await heartbeat.reconcileResolvedDependencyWakes({ companyId: fixture.companyId });
    expect(again.healed).toBe(0);
    expect(await dependencyWakes(fixture.companyId)).toHaveLength(1);
    expect(await successorRuns(run.id)).toHaveLength(0);
  }, 30_000);
});
