import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  autonomousBudgetReservations,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
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
