import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { activityLog, agents, autonomousBudgetReservations, budgetPolicies, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
    const [companyPolicy, agentPolicy, taskPolicy, lifetimePolicy] = await db.insert(budgetPolicies).values([
      { companyId: first, scopeType: "company", scopeId: first, metric: "billed_microusd",
        windowKind: "calendar_month_utc", amount: 1_000_000 },
      { companyId: first, scopeType: "agent", scopeId: a, metric: "input_tokens",
        windowKind: "calendar_month_utc", amount: 100_000 },
      { companyId: first, scopeType: "task", scopeId: task, metric: "request_count",
        windowKind: "per_run", amount: 8 },
      { companyId: first, scopeType: "task", scopeId: task, metric: "output_tokens",
        windowKind: "lifetime", amount: 10_000 },
      { companyId: second, scopeType: "company", scopeId: second, metric: "billed_microusd",
        windowKind: "calendar_month_utc", amount: 1_000_000 },
    ]).returning({ id: budgetPolicies.id });
    await db.insert(autonomousBudgetReservations).values({
      companyId: first, agentId: a, issueId: task, runId: randomUUID(),
      status: "reserved", reservedRequestCount: 0, reservedOutputTokens: 900,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
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
      { companyId: first, actorId: "autonomous-budget-reservation", action: "company.continuity_cost_velocity",
        entityType: "company", entityId: first, agentId: a,
        details: { sourceRunId: run, policyId: randomUUID(), committedCostMicrousd: 300_000,
          dailyLimitMicrousd: 1_000_000, windowMinutes: 15 } },
      { companyId: second, actorId: "continuity-circuit-breaker", action: "issue.continuity_circuit_opened",
        entityType: "issue", entityId: randomUUID(), agentId: b,
        details: { stateFingerprint: "other", circuitOpenedAt: "2026-09-27T00:00:00.000Z" } },
      { companyId: second, actorId: "autonomous-budget-reservation", action: "company.continuity_cost_velocity",
        entityType: "company", entityId: second, agentId: b,
        details: { sourceRunId: randomUUID(), policyId: randomUUID(), committedCostMicrousd: 999_000,
          dailyLimitMicrousd: 1_000_000, windowMinutes: 15 } },
    ]);
    const snapshot = await autonomousContinuitySnapshot(db, first);
    expect(snapshot).toMatchObject({
      companyId: first, paused: true,
      totals: { runs: 3, requests: 9, inputTokens: 65000, outputTokens: 9000,
        costMicrousd: 270000, held: 2, missingTelemetry: 1 },
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
      costVelocityAlerts: [expect.objectContaining({ companyId: first, agentId: a, runId: run,
        committedCostMicrousd: 300_000, dailyLimitMicrousd: 1_000_000, windowMinutes: 15 })],
      policyLimits: expect.arrayContaining([
        expect.objectContaining({ id: companyPolicy.id, scopeType: "company", metric: "billed_microusd",
          amount: 1_000_000, committed: 270_000, remaining: 730_000 }),
        expect.objectContaining({ id: agentPolicy.id, scopeType: "agent", scopeId: a,
          metric: "input_tokens", amount: 100_000, committed: 65_000, remaining: 35_000 }),
        expect.objectContaining({ id: taskPolicy.id, scopeType: "task", scopeId: task,
          metric: "request_count", amount: 8, committed: null, remaining: null }),
        expect.objectContaining({ id: lifetimePolicy.id, windowKind: "lifetime", amount: 10_000,
          committed: 9_000, remaining: 1_000 }),
      ]),
    });
    expect(snapshot?.policyLimits).toHaveLength(4);
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
