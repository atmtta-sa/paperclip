import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  agents,
  automaticSuccessorIntents,
  autonomousBudgetReservations,
  companies,
  createDb,
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

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskRun: vi.fn() };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "provider_outcome_unknown_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat provider-outcome tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The adapter behavior for the current test.
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

describeEmbeddedPostgres("heartbeat provider-outcome-unknown classification (COM-275)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;
  let fixture!: { companyId: string; agentId: string; issueId: string };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-outcome-unknown-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      verifyBudgetEvidenceForTest: (result) => result.budgetTelemetry ?? null,
    });
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-outcome-unknown-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => adapterBehavior({ runId: ctx.runId }),
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 90_000);

  afterEach(async () => {
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

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Outcome unknown heartbeat",
      issuePrefix: `OU${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
      autonomousExecutionPaused: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OutcomeUnknownAgent",
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
      title: "Resolve through an uncertain provider outcome",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await seedSyntheticCompanyBudgets(db, companyId);
    fixture = { companyId, agentId, issueId };
  }

  async function invokeAndDrain() {
    const run = await heartbeat.invoke(fixture.agentId, "on_demand", { issueId: fixture.issueId }, "manual");
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return { run: run!, finished };
  }

  it("reports the COM-275 sequence as unknown provider outcome — not a route-policy mismatch — and retains the reservation", async () => {
    await seedFixture();
    // The durable evidence for run e7edfe1d-…: three completed requests, one
    // dispatched attempt recorded outcome_unknown after a connection refusal,
    // then one automatic retry that completed. Five boundary crossings under a
    // four-request allowance; the evidence is incomplete and cannot settle.
    adapterBehavior = async ({ runId }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Partial work before transport failure",
      resultJson: {
        durableCallEvidence: {
          status: "incomplete",
          source: "hermes_sqlite_transport_owner",
          contractVersion: 3,
          runId,
          complete: false,
          executionComplete: false,
          iterationAttempts: 5,
          providerDispatches: 5,
          confirmedResponses: 4,
          pretransportDenials: 0,
          rejectedAfterDispatch: 0,
          unknownOutcomes: 1,
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          providerRequestIds: [],
          terminalDiscrepancies: [],
        },
      },
    });

    const { finished } = await invokeAndDrain();
    expect(finished).toMatchObject({
      status: "failed",
      errorCode: "provider_outcome_unknown",
    });
    expect(finished?.error).toContain("Provider outcome unknown after dispatch");

    const resultJson = (finished?.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.budgetSettlement).toMatchObject({
      status: "retained_missing_telemetry",
      settlementState: "uncertain_requires_reconciliation",
      accountingErrorCode: "provider_outcome_unknown",
      unresolvedPostDispatchOutcomes: true,
    });
    expect(typeof resultJson.rootChainCommittedRequests).toBe("number");

    // Fail closed: reservation retained, no settlement, no successor, issue untouched.
    const reservation = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, finished!.id)).then((rows) => rows[0]);
    expect(reservation).toMatchObject({
      status: "retained_missing_telemetry",
      settlementState: "uncertain_requires_reconciliation",
      actualRequestCount: null,
    });
    expect(resultJson.rootChainCommittedRequests).toBe(reservation.reservedRequestCount);
    const intents = await db.select().from(automaticSuccessorIntents)
      .where(eq(automaticSuccessorIntents.companyId, fixture.companyId));
    expect(intents).toHaveLength(0);
    const issue = await db.select().from(issues)
      .where(eq(issues.id, fixture.issueId)).then((rows) => rows[0]);
    expect(issue.status).toBe("in_progress");
  });

  it("keeps the generic telemetry-missing classification when no post-dispatch outcome is unresolved", async () => {
    await seedFixture();
    adapterBehavior = async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Completed without durable evidence",
      resultJson: {},
    });

    const { finished } = await invokeAndDrain();
    expect(finished).toMatchObject({
      status: "failed",
      errorCode: "telemetry_missing",
    });
    const resultJson = (finished?.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.budgetSettlement).toMatchObject({
      status: "retained_missing_telemetry",
      accountingErrorCode: "telemetry_missing",
      unresolvedPostDispatchOutcomes: false,
    });
  });
});
