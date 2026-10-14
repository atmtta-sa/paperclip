import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import {
  reconcileAutonomousBudget,
  reserveAutonomousBudget,
} from "../services/autonomous-budget-reservations.js";

// COM-275 settlement classification: incomplete or unknown provider outcome
// must never collapse into autonomous_budget_reconciliation_route_policy_mismatch.
// A concrete route-policy field mismatch still fails closed and names the field.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const billingPolicy = {
  policyId: "codex-subscription-route",
  policyVersion: 1,
  policyDigest: "b".repeat(64),
  billingMode: "subscription_included" as const,
  credentialPrincipalId: "managed-account:codex-uat",
  maxRootChainProviderRequests: 12,
};

describeEmbeddedPostgres("autonomous budget reconciliation evidence classification", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reconciliation-evidence-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createScope() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reconciliation evidence company",
      autonomousExecutionPaused: false,
      issuePrefix: `RE${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconciliation evidence agent",
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reconciliation evidence",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "task",
      scopeId: issueId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 500,
      hardStopEnabled: true,
    });
    return { companyId, agentId, issueId };
  }

  async function reserveSubscription(scope: { companyId: string; agentId: string; issueId: string },
    runId: string, previousRunId?: string) {
    const reserved = await reserveAutonomousBudget(db, {
      ...scope,
      runId,
      previousRunId,
      provider: "openai-codex",
      model: "gpt-5.6-codex",
      billingPolicy,
      requested: { requestCount: 4, inputTokens: 25_000, outputTokens: 2_000, runtimeMs: 90_000 },
    });
    expect(reserved).toMatchObject({
      admitted: true,
      envelope: { requestCount: 4, costMicrousd: null },
    });
    return reserved;
  }

  function completeEvidence(runId: string, overrides: Record<string, unknown> = {}) {
    return {
      source: "hermes_sqlite_transport_owner", contractVersion: 3, runId,
      digestSha256: "a".repeat(64), costBasis: "subscription_included",
      runtimeBasis: null, runtimeApplicability: "unavailable_by_route",
      billingMode: "subscription_included", routePolicyId: billingPolicy.policyId,
      routePolicyVersion: billingPolicy.policyVersion,
      routePolicyDigest: billingPolicy.policyDigest,
      credentialPrincipalId: billingPolicy.credentialPrincipalId,
      rootChainRequestLimit: billingPolicy.maxRootChainProviderRequests,
      tokenAccountingBasis: "provider_reported_tokens_v1",
      ...overrides,
    };
  }

  it("retains the reservation as uncertain when evidence is incomplete — never as a route-policy mismatch (COM-275)", async () => {
    // COM-275: attempt 4 crossed the transport boundary and was recorded
    // outcome_unknown after a connection refusal; a retry then completed.
    // The durable evidence is incomplete, so no settlement provenance exists.
    // The recorded route-policy tuple matched the authorized policy; the old
    // code nevertheless surfaced route_policy_mismatch.
    const scope = await createScope();
    const runId = randomUUID();
    await reserveSubscription(scope, runId);

    const result = await reconcileAutonomousBudget(db, {
      ...scope,
      runId,
      providerActivityOccurred: true,
      providerRequestId: null,
      billingMode: "subscription_included",
      actual: null,
      settlementEvidence: null,
    });

    expect(result).toMatchObject({
      status: "retained_missing_telemetry",
      settlementState: "uncertain_requires_reconciliation",
      replayed: false,
    });
    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    // Fail closed: nothing settled, nothing released, full reservation retained.
    expect(row).toMatchObject({
      status: "retained_missing_telemetry",
      settlementState: "uncertain_requires_reconciliation",
      actualRequestCount: null,
      providerActivityOccurred: true,
    });
  });

  it.each([
    ["absent", null],
    ["partial", { billingMode: "subscription_included", routePolicyId: billingPolicy.policyId }],
  ])("retains complete usage telemetry when route-policy evidence is %s", async (_label, evidence) => {
    const scope = await createScope();
    const runId = randomUUID();
    await reserveSubscription(scope, runId);

    const result = await reconcileAutonomousBudget(db, {
      ...scope,
      runId,
      providerActivityOccurred: true,
      providerRequestId: "response-sub-incomplete-policy",
      billingMode: "subscription_included",
      actual: { requestCount: 1, inputTokens: 100, outputTokens: 20, runtimeMs: 1_000 },
      settlementEvidence: evidence as ReturnType<typeof completeEvidence> | null,
    });

    expect(result).toMatchObject({
      status: "retained_missing_telemetry",
      settlementState: "uncertain_requires_reconciliation",
      replayed: false,
      rootChainCommittedRequests: 4,
    });
    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "retained_missing_telemetry",
      settlementState: "uncertain_requires_reconciliation",
      actualRequestCount: null,
    });
  });

  it("recovers a retained subscription reservation when authoritative telemetry arrives", async () => {
    const scope = await createScope();
    const runId = randomUUID();
    await reserveSubscription(scope, runId);
    await reconcileAutonomousBudget(db, {
      ...scope, runId, providerActivityOccurred: true, providerRequestId: null,
      billingMode: "subscription_included", actual: null, settlementEvidence: null,
    });

    const recovered = await reconcileAutonomousBudget(db, {
      ...scope, runId, providerActivityOccurred: true, providerRequestId: "response-sub-1",
      billingMode: "subscription_included",
      actual: { requestCount: 2, inputTokens: 200, outputTokens: 40, runtimeMs: null },
      settlementEvidence: completeEvidence(runId),
    });

    expect(recovered).toMatchObject({
      status: "reconciled",
      settlementState: "partially_consumed",
      replayed: false,
      rootChainCommittedRequests: 2,
    });

    const replayed = await reconcileAutonomousBudget(db, {
      ...scope, runId, providerActivityOccurred: true, providerRequestId: "response-sub-1",
      billingMode: "subscription_included",
      actual: { requestCount: 2, inputTokens: 200, outputTokens: 40, runtimeMs: null },
      settlementEvidence: completeEvidence(runId),
    });
    expect(replayed).toMatchObject({
      status: "reconciled",
      settlementState: "partially_consumed",
      replayed: true,
      rootChainCommittedRequests: 2,
    });
  });

  it("fails closed and names the concrete field on a genuine route-policy mismatch", async () => {
    const scope = await createScope();
    const runId = randomUUID();
    await reserveSubscription(scope, runId);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["billing_mode", { billingMode: "metered_currency" }],
      ["route_policy_id", { routePolicyId: "other-policy" }],
      ["route_policy_version", { routePolicyVersion: 2 }],
      ["route_policy_digest", { routePolicyDigest: "c".repeat(64) }],
      ["credential_principal_id", { credentialPrincipalId: "managed-account:other" }],
      ["root_chain_request_limit", { rootChainRequestLimit: 24 }],
    ];
    for (const [field, override] of cases) {
      await expect(reconcileAutonomousBudget(db, {
        ...scope, runId, providerActivityOccurred: true, providerRequestId: "response-sub-1",
        billingMode: "subscription_included",
        actual: { requestCount: 1, inputTokens: 100, outputTokens: 20, runtimeMs: null },
        settlementEvidence: completeEvidence(runId, override),
      })).rejects.toThrow(`autonomous_budget_reconciliation_route_policy_mismatch:${field}`);
    }

    // The reservation is untouched by every denied classification.
    const row = await db.select().from(autonomousBudgetReservations)
      .where(eq(autonomousBudgetReservations.runId, runId)).then((rows) => rows[0]);
    expect(row.status).toBe("reserved");
  });

  it("reconciles when every concrete route-policy field matches", async () => {
    const scope = await createScope();
    const runId = randomUUID();
    await reserveSubscription(scope, runId);
    await expect(reconcileAutonomousBudget(db, {
      ...scope, runId, providerActivityOccurred: true, providerRequestId: "response-sub-1",
      billingMode: "subscription_included",
      actual: { requestCount: 4, inputTokens: 25_000, outputTokens: 2_000, runtimeMs: null },
      settlementEvidence: completeEvidence(runId),
    })).resolves.toMatchObject({ status: "reconciled", settlementState: "consumed" });
  });

  it("keeps the per-run allowance independent from cumulative root-chain consumption", async () => {
    const scope = await createScope();
    const rootRunId = randomUUID();
    await reserveSubscription(scope, rootRunId);
    // Root run consumed 2 of its 4 admitted requests.
    await reconcileAutonomousBudget(db, {
      ...scope, runId: rootRunId, providerActivityOccurred: true,
      providerRequestId: "response-root",
      billingMode: "subscription_included",
      actual: { requestCount: 2, inputTokens: 200, outputTokens: 40, runtimeMs: null },
      settlementEvidence: completeEvidence(rootRunId),
    });

    // The successor still receives a full per-run envelope of 4 (not reduced by
    // chain consumption); the chain ceiling of 12 is enforced separately.
    const successorRunId = randomUUID();
    const successor = await reserveSubscription(scope, successorRunId, rootRunId);
    expect(successor).toMatchObject({ admitted: true, envelope: { requestCount: 4 } });

    // Cumulative root-chain consumption is surfaced for sufficiency telemetry:
    // reconciled actual (2) + reserved successor envelope (4).
    const settled = await reconcileAutonomousBudget(db, {
      ...scope, runId: successorRunId, providerActivityOccurred: true,
      providerRequestId: "response-successor",
      billingMode: "subscription_included",
      actual: { requestCount: 4, inputTokens: 400, outputTokens: 80, runtimeMs: null },
      settlementEvidence: completeEvidence(successorRunId),
    });
    expect(settled).toMatchObject({ status: "reconciled", rootChainCommittedRequests: 6 });
  });

  it("enforces the 12-request root-chain ceiling across the lineage while each run keeps its own allowance", async () => {
    const scope = await createScope();
    const rootRunId = randomUUID();
    await reserveSubscription(scope, rootRunId);
    const secondRunId = randomUUID();
    await reserveSubscription(scope, secondRunId, rootRunId);
    const thirdRunId = randomUUID();
    await reserveSubscription(scope, thirdRunId, secondRunId);
    // 3 runs x 4 requests = 12 committed; a fourth run would cross the ceiling.
    await expect(reserveSubscription(scope, randomUUID(), thirdRunId))
      .rejects.toThrow("autonomous_budget_root_chain_request_limit_exceeded");
  });
});
