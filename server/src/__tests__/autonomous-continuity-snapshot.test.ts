import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { agents, autonomousBudgetReservations, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { autonomousContinuitySnapshot } from "../services/autonomous-continuity-snapshot.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("autonomous continuity operator snapshot", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-continuity-snapshot-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });

  it("isolates companies, counts retained reservations and exposes the exact run circuit", async () => {
    const first = randomUUID();
    const second = randomUUID();
    await db.insert(companies).values([
      { id: first, name: "First", issuePrefix: `CS${first.slice(0, 4)}`, requireBoardApprovalForNewAgents: false, status: "paused" },
      { id: second, name: "Second", issuePrefix: `CS${second.slice(0, 4)}`, requireBoardApprovalForNewAgents: false },
    ]);
    const a = randomUUID();
    const b = randomUUID();
    await db.insert(agents).values([
      { id: a, companyId: first, name: "A", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: b, companyId: second, name: "B", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const task = randomUUID();
    await db.insert(issues).values({ id: task, companyId: first, title: "First task", status: "in_progress", assigneeAgentId: a });
    const run = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: run, companyId: first, agentId: a, status: "failed",
      workOutcome: "telemetry_missing", stateFingerprintBefore: "before",
      stateFingerprintAfter: "before", noProgressStreak: 2,
      continuityCircuitState: "open", errorCode: "missing_usage",
    });
    await db.insert(autonomousBudgetReservations).values([
      { companyId: first, agentId: a, issueId: task, runId: run,
        status: "retained_missing_telemetry", reservedRequestCount: 8,
        reservedInputTokens: 64000, reservedOutputTokens: 8000, reservedCostMicrousd: 250000 },
      { companyId: second, agentId: b, runId: randomUUID(),
        reservedRequestCount: 100, reservedCostMicrousd: 900000 },
    ]);
    await db.insert(autonomousBudgetReservations).values([
      { companyId: first, agentId: a, issueId: task, runId: randomUUID(), status: "released",
        reservedRequestCount: 50, reservedInputTokens: 100000, reservedCostMicrousd: 750000 },
      { companyId: first, agentId: a, issueId: task, runId: randomUUID(), status: "reconciled",
        reservedRequestCount: 4, actualRequestCount: 1, reservedInputTokens: 10000,
        actualInputTokens: 1000, reservedOutputTokens: 2000, actualOutputTokens: 100,
        reservedCostMicrousd: 50000, actualCostMicrousd: 20000 },
    ]);
    const snapshot = await autonomousContinuitySnapshot(db, first);
    expect(snapshot).toMatchObject({
      companyId: first, paused: true,
      totals: { runs: 2, requests: 9, inputTokens: 65000, outputTokens: 8100,
        costMicrousd: 270000, held: 1, missingTelemetry: 1 },
      recent: expect.arrayContaining([expect.objectContaining({ runId: run, agentId: a, issueId: task,
        reservationStatus: "retained_missing_telemetry", workOutcome: "telemetry_missing",
        fingerprintBefore: "before", fingerprintAfter: "before", noProgressStreak: 2,
        circuitState: "open", stopReason: "missing_usage" })]),
    });
    expect(await autonomousContinuitySnapshot(db, randomUUID())).toBeNull();
  });
});
