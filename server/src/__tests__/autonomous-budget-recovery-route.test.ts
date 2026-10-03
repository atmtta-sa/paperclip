import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, autonomousBudgetReservations, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Board budget recovery endpoint", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery test", issuePrefix: `BR${companyId.slice(0, 6)}`, autonomousExecutionPaused: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Paused test agent", role: "engineer", status: "paused", adapterType: "hermes_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recovery test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", errorCode: "context_budget_exceeded", resultJson: { budget_failure_reason: "cumulative_input_tokens_exceeded", historical: true } });
    await db.insert(autonomousBudgetReservations).values({ companyId, agentId, issueId, runId, chainRootRunId: runId, status: "retained_missing_telemetry", settlementState: "uncertain_requires_reconciliation", reservedRequestCount: 3, reservedInputTokens: 25_000, reservedOutputTokens: 1000, reservedRuntimeMs: 30_000, provider: "openai-codex", model: "test-model" });
    return { companyId, agentId, issueId, runId };
  }
  const board = (companyId: string) => ({ type: "board", source: "session", userId: "recovery-operator", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] });
  function app(actor: any) {
    const app = express();
    app.use(express.json({ limit: "16kb" }));
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", costRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const url = (s: Awaited<ReturnType<typeof fixture>>) => `/api/companies/${s.companyId}/budgets/autonomous-reservations/${s.runId}/recover`;
  const body = (s: Awaited<ReturnType<typeof fixture>>) => ({
    agentId: s.agentId, issueId: s.issueId, provider: "openai-codex", model: "test-model", providerRequestId: "test-response-3",
    actual: { requestCount: 3, inputTokens: 29_729, outputTokens: 634, runtimeMs: 27_379, costMicrousd: 0 },
    evidence: { usageSha256: "a".repeat(64), billingSha256: "b".repeat(64), billingBasis: "subscription_included", operatorAttested: true },
  });
  async function reservation(runId: string) {
    return (await db.select().from(autonomousBudgetReservations).where(eq(autonomousBudgetReservations.runId, runId)))[0];
  }
  async function assertNoMutation(s: Awaited<ReturnType<typeof fixture>>, before: unknown) {
    expect(await reservation(s.runId)).toEqual(before);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId))).toHaveLength(0);
  }

  it.each(["none", "agent", "other_company", "viewer"])("denies %s without settlement or audit", async (kind) => {
    const s = await fixture(), before = await reservation(s.runId);
    const actor: any = kind === "none" ? { type: "none" } : kind === "agent" ? { type: "agent", agentId: s.agentId, companyId: s.companyId } : board(kind === "other_company" ? randomUUID() : s.companyId);
    if (kind === "viewer") actor.memberships[0].membershipRole = "viewer";
    expect((await request(app(actor)).post(url(s)).send(body(s))).status).toBe(403);
    await assertNoMutation(s, before);
  });
  it.each(["missing_evidence", "missing_cost", "unattested", "invalid_hash", "negative_usage", "included_nonzero_cost", "extra_field"])("rejects %s without mutation", async (kind) => {
    const s = await fixture(), before = await reservation(s.runId), payload: any = body(s);
    if (kind === "missing_evidence") delete payload.evidence;
    if (kind === "missing_cost") delete payload.actual.costMicrousd;
    if (kind === "unattested") payload.evidence.operatorAttested = false;
    if (kind === "invalid_hash") payload.evidence.usageSha256 = "not-a-hash";
    if (kind === "negative_usage") payload.actual.inputTokens = -1;
    if (kind === "included_nonzero_cost") payload.actual.costMicrousd = 1;
    if (kind === "extra_field") payload.verifiedNoProviderActivity = true;
    expect((await request(app(board(s.companyId))).post(url(s)).send(payload)).status).toBe(400);
    await assertNoMutation(s, before);
  });
  it.each(["agent", "issue", "provider", "model", "active_run", "reserved"])("rejects %s scope/state mismatch", async (kind) => {
    const s = await fixture(), payload = body(s);
    if (kind === "agent") payload.agentId = randomUUID();
    if (kind === "issue") payload.issueId = randomUUID();
    if (kind === "provider") payload.provider = "wrong-provider";
    if (kind === "model") payload.model = "wrong-model";
    if (kind === "active_run") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, s.runId));
    if (kind === "reserved") await db.update(autonomousBudgetReservations).set({ status: "reserved", settlementState: null }).where(eq(autonomousBudgetReservations.runId, s.runId));
    const before = await reservation(s.runId);
    expect((await request(app(board(s.companyId))).post(url(s)).send(payload)).status).toBe(409);
    await assertNoMutation(s, before);
  });
  it.each(["missing_run", "foreign_run"])("returns 404 for %s without mutation", async (kind) => {
    const s = await fixture(), before = await reservation(s.runId);
    const target = kind === "foreign_run" ? await fixture() : { runId: randomUUID() };
    const path = url({ ...s, runId: target.runId });
    expect((await request(app(board(s.companyId))).post(path).send(body(s))).status).toBe(404);
    await assertNoMutation(s, before);
  });
  it("rolls back recovery when the durable audit insert fails", async () => {
    const s = await fixture(), before = await reservation(s.runId);
    // Disposable test database only; force a real database audit failure.
    await db.execute(sql`ALTER TABLE activity_log ADD CONSTRAINT recovery_test_audit_failure CHECK (action <> 'autonomous_budget.telemetry_recovered') NOT VALID`);
    try {
      expect((await request(app(board(s.companyId))).post(url(s)).send(body(s))).status).toBe(500);
      await assertNoMutation(s, before);
    } finally {
      await db.execute(sql`ALTER TABLE activity_log DROP CONSTRAINT recovery_test_audit_failure`);
    }
  });
  it("recovers full input, audits once, preserves history/pauses, and rejects contradictory replay", async () => {
    const s = await fixture(), payload = body(s), application = app(board(s.companyId));
    const historical = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId));
    const first = await request(application).post(url(s)).send(payload);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "reconciled", settlementState: "consumed_over_reservation", replayed: false });
    expect(await reservation(s.runId)).toMatchObject({ actualInputTokens: 29_729, overrunInputTokens: 4729, actualCostMicrousd: 0 });
    const settled = await reservation(s.runId);
    expect((await request(application).post(url(s)).send(payload)).body.replayed).toBe(true);
    payload.actual.inputTokens++;
    expect((await request(application).post(url(s)).send(payload)).status).toBe(409);
    expect(await reservation(s.runId)).toEqual(settled);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId))).toEqual(historical);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).toHaveLength(1);
    expect((await db.select().from(companies).where(eq(companies.id, s.companyId)))[0].autonomousExecutionPaused).toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, s.agentId)))[0].status).toBe("paused");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId))).toHaveLength(0);
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId));
    expect(audit.filter((row) => row.action === "autonomous_budget.telemetry_recovered")).toHaveLength(1);
    expect(audit.find((row) => row.action === "autonomous_budget.telemetry_recovered")).toMatchObject({ actorId: "recovery-operator", details: { evidence: body(s).evidence } });
  });
});
