import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  autonomousBudgetReservations,
  budgetPolicies,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dispatchWithAutonomousBudgetReservation } from "../services/autonomous-budget-dispatch.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat budget dispatch gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-dispatch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScope() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Budget dispatch company",
      autonomousExecutionPaused: false,
      issuePrefix: `BD${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget dispatch agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Budget dispatch task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values([
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "lifetime", amount: 1_000_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "request_count", windowKind: "per_run", amount: 8 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "input_tokens", windowKind: "per_run", amount: 64_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "output_tokens", windowKind: "per_run", amount: 8_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "runtime_ms", windowKind: "per_run", amount: 300_000 },
      { companyId, scopeType: "task", scopeId: issueId, metric: "billed_microusd", windowKind: "per_run", amount: 250_000 },
    ]);
    return { companyId, agentId, issueId };
  }

  it("commits a reservation before entering the adapter callback", async () => {
    const scope = await seedScope();
    const runId = randomUUID();
    const adapter = vi.fn(async () => {
      const rows = await db
        .select()
        .from(autonomousBudgetReservations)
        .where(eq(autonomousBudgetReservations.runId, runId));
      expect(rows).toHaveLength(1);
      return "adapter-result";
    });

    const result = await dispatchWithAutonomousBudgetReservation(
      db,
      { ...scope, runId },
      adapter,
    );

    expect(result).toBe("adapter-result");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("passes the exact reserved envelope on initial dispatch and replay", async () => {
    const scope = await seedScope();
    const runId = randomUUID();
    const envelopes: unknown[] = [];
    const adapter = vi.fn(async (reservation: { envelope: unknown }) => {
      envelopes.push(reservation.envelope);
      return "adapter-result";
    });

    await dispatchWithAutonomousBudgetReservation(db, { ...scope, runId }, adapter);
    await dispatchWithAutonomousBudgetReservation(db, { ...scope, runId }, adapter);

    expect(envelopes).toEqual([
      {
        requestCount: 8,
        inputTokens: 64_000,
        outputTokens: 8_000,
        runtimeMs: 300_000,
        costMicrousd: 250_000,
      },
      {
        requestCount: 8,
        inputTokens: 64_000,
        outputTokens: 8_000,
        runtimeMs: 300_000,
        costMicrousd: 250_000,
      },
    ]);
  });

  it("denies new and replay dispatch while autonomous execution is paused", async () => {
    const scope = await seedScope();
    const runId = randomUUID();
    const adapter = vi.fn(async () => "started");
    expect(await dispatchWithAutonomousBudgetReservation(db, { ...scope, runId }, adapter)).toBe("started");
    await db.update(companies).set({ autonomousExecutionPaused: true }).where(eq(companies.id, scope.companyId));
    await expect(dispatchWithAutonomousBudgetReservation(db, { ...scope, runId: randomUUID() }, adapter))
      .rejects.toMatchObject({ reason: "autonomous_execution_paused" });
    await expect(dispatchWithAutonomousBudgetReservation(db, { ...scope, runId }, adapter))
      .rejects.toMatchObject({ reason: "autonomous_execution_paused" });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("does not enter the adapter callback when a run envelope dimension is missing", async () => {
    const scope = await seedScope();
    await db
      .delete(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, scope.companyId),
          eq(budgetPolicies.scopeId, scope.issueId),
          eq(budgetPolicies.metric, "output_tokens"),
          eq(budgetPolicies.windowKind, "per_run"),
        ),
      );
    const adapter = vi.fn();

    await expect(
      dispatchWithAutonomousBudgetReservation(
        db,
        { ...scope, runId: randomUUID() },
        adapter,
      ),
    ).rejects.toThrow("autonomous_run_budget_policy_missing:outputTokens");
    expect(adapter).not.toHaveBeenCalled();
  });

  it("throws a structured denial without entering the adapter callback", async () => {
    const scope = await seedScope();
    await db
      .update(budgetPolicies)
      .set({ amount: 0 })
      .where(
        and(
          eq(budgetPolicies.companyId, scope.companyId),
          eq(budgetPolicies.scopeId, scope.issueId),
          eq(budgetPolicies.metric, "billed_microusd"),
          eq(budgetPolicies.windowKind, "lifetime"),
        ),
      );
    const adapter = vi.fn();

    await expect(
      dispatchWithAutonomousBudgetReservation(
        db,
        { ...scope, runId: randomUUID() },
        adapter,
      ),
    ).rejects.toMatchObject({
      name: "AutonomousBudgetAdmissionError",
      reason: "task_budget_exhausted",
      policyId: expect.any(String),
    });
    expect(adapter).not.toHaveBeenCalled();
  });
});
