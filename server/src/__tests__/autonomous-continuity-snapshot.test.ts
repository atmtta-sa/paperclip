import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { activityLog, agents, autonomousBudgetReservations, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
    await db.insert(activityLog).values([
      { companyId: first, actorId: "continuity-circuit-breaker", action: "issue.continuity_circuit_opened",
        entityType: "issue", entityId: task, agentId: a, runId: run,
        details: { stateFingerprint: "before", circuitOpenedAt: "2026-09-27T00:00:00.000Z" } },
      { companyId: first, actorId: "autonomous-budget-reconciliation", action: "issue.continuity_prompt_growth",
        entityType: "issue", entityId: task, agentId: a, runId: run,
        details: { previousInputTokens: 10_000, actualInputTokens: 35_000, provider: "openrouter", model: "test-model" } },
      { companyId: first, actorId: "autonomous-budget-reconciliation", action: "issue.continuity_prompt_growth",
        entityType: "issue", entityId: task, agentId: a,
        details: { sourceRunId: "orphan-run", previousInputTokens: 35_000,
          actualInputTokens: 80_000, provider: "openrouter", model: "test-model" } },
      { companyId: second, actorId: "continuity-circuit-breaker", action: "issue.continuity_circuit_opened",
        entityType: "issue", entityId: randomUUID(), agentId: b,
        details: { stateFingerprint: "other", circuitOpenedAt: "2026-09-27T00:00:00.000Z" } },
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
      circuitAlerts: [expect.objectContaining({ issueId: task, agentId: a, runId: run,
        stateFingerprint: "before" })],
      promptGrowthAlerts: expect.arrayContaining([
        expect.objectContaining({ issueId: task, agentId: a, runId: run,
          previousInputTokens: 10_000, actualInputTokens: 35_000 }),
        expect.objectContaining({ issueId: task, runId: "orphan-run",
          previousInputTokens: 35_000, actualInputTokens: 80_000 }),
      ]),
    });
    expect(await autonomousContinuitySnapshot(db, randomUUID())).toBeNull();
    await db.update(companies).set({ status: "active", autonomousExecutionPaused: true })
      .where(eq(companies.id, first));
    expect(await autonomousContinuitySnapshot(db, first)).toMatchObject({
      paused: true, autonomousPaused: true,
    });
    await db.update(agents).set({ autonomousExecutionPaused: true }).where(eq(agents.id, a));
    await db.update(issues).set({ autonomousExecutionPaused: true }).where(eq(issues.id, task));
    expect(await autonomousContinuitySnapshot(db, first)).toMatchObject({
      recent: expect.arrayContaining([expect.objectContaining({ runId: run,
        agentAutonomousPaused: true, taskAutonomousPaused: true })]),
    });
  });
});
