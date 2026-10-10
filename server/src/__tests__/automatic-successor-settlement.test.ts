import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { settleSyntheticRetryPredecessor } from "./helpers/synthetic-retry-settlement.js";
import { seedSyntheticCompanyBudgets } from "./helpers/synthetic-autonomous-budgets.js";
import { reserveAutonomousBudget } from "../services/autonomous-budget-reservations.js";
import { reconcileAutonomousBudget } from "../services/autonomous-budget-reconciliation.js";
import {
  lockEligibleAutomaticSuccessorSettlement,
  predecessorRetryAuthorityAllows,
  predecessorRetryPolicyAllows,
} from "../services/automatic-successor-settlement.js";
import { managedHermesSettlementProvenance } from "../services/managed-budget-evidence.js";

type Run = typeof heartbeatRuns.$inferSelect;

describe("automatic successor accounting eligibility", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-successor-settlement-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture(adapterType = "hermes_local") {
    const [company] = await db.insert(companies).values({
      name: "Successor accounting fixture", issuePrefix: randomUUID(), autonomousExecutionPaused: false,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id, name: "Fixture", role: "engineer", adapterType,
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company!.id, title: "Accounting prerequisite", status: "in_progress",
      assigneeAgentId: agent!.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id, agentId: agent!.id, status: "failed", finishedAt: new Date(),
      errorCode: "transient_error", contextSnapshot: { issueId: issue!.id },
    }).returning();
    return run!;
  }

  async function eligible(run: Run) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id = ${run.companyId} for no key update`);
      const issueId = run.nativeIssueId ?? run.contextSnapshot?.issueId;
      if (typeof issueId === "string" && issueId) {
        await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      }
      return lockEligibleAutomaticSuccessorSettlement(tx as unknown as typeof db, run);
    });
  }

  async function settled() {
    const run = await fixture();
    await db.update(heartbeatRuns).set({ resultJson: {
      executionRecovery: { kind: "provider", providerWorkStarted: true },
    } }).where(eq(heartbeatRuns.id, run.id));
    await settleSyntheticRetryPredecessor(db, run.id, {
      basis: "synthetic_completed_request", provider: "hermes_local",
    });
    return run;
  }

  async function update(run: Run, change: Partial<Run>) {
    const [changed] = await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, run.id)).returning();
    return changed!;
  }

  async function zeroRelease(run: Run) {
    await seedSyntheticCompanyBudgets(db, run.companyId);
    const scope = { companyId: run.companyId, agentId: run.agentId,
      issueId: run.contextSnapshot!.issueId as string, runId: run.id };
    const reserved = await reserveAutonomousBudget(db, { ...scope, provider: "fixture", model: "fixture" });
    expect(reserved.admitted).toBe(true);
    await reconcileAutonomousBudget(db, { ...scope, providerActivityOccurred: false,
      verifiedNoProviderActivity: true, providerRequestId: null, actual: null });
  }

  it("rejects a consumed managed Hermes predecessor without v2 durable evidence", async () => {
    expect(await eligible(await settled())).toBe(false);
  });

  it("preserves legacy non-Hermes settlement eligibility without usage projection", async () => {
    const run = await fixture("test");
    await update(run, { resultJson: {
      executionRecovery: { kind: "provider", providerWorkStarted: true },
    } });
    await settleSyntheticRetryPredecessor(db, run.id, {
      basis: "synthetic_completed_request", provider: "test",
    });
    expect(await eligible(run)).toBe(true);
  });

  it("requires v2 durable evidence for a consumed managed Hermes predecessor", async () => {
    const run = await fixture();
    const durableCallEvidence = {
      status: "complete", source: "hermes_sqlite_transport_owner", contractVersion: 2,
      runId: run.id, complete: true, iterationAttempts: 1, providerDispatches: 1,
      confirmedResponses: 1, pretransportDenials: 0, unknownOutcomes: 0,
      requestCount: 1, inputTokens: 1, outputTokens: 1,
      providerRuntimeMs: 1, runtimeBasis: "confirmed_provider_call_ms_v1",
      providerRequestIds: [`synthetic-retry-receipt:${run.id}`],
      costMicrousd: 1, costBasis: "provider_actual",
      costAuthority: "provider_usage_response",
      costAuthorityRef: `synthetic-retry-receipt:${run.id}`,
      estimatedCostUsd: 0.000001, terminalDiscrepancies: [],
    };
    const adapterResult = { resultJson: { durableCallEvidence } } as any;
    await update(run, { resultJson: {
      executionRecovery: { kind: "provider", providerWorkStarted: true },
      durableCallEvidence,
    } });
    await settleSyntheticRetryPredecessor(db, run.id, {
      basis: "synthetic_completed_request",
      provider: "hermes_local",
      settlementEvidence: managedHermesSettlementProvenance(adapterResult, run.id)!,
    });
    const changed = await update(run, { usageJson: {
      inputTokens: 1, outputTokens: 1, requestCount: 1, runtimeMs: 1,
    } });
    expect(await eligible(changed)).toBe(true);
  });

  it("denies the persisted request-cap shape despite conversation continuation", () => {
    const persisted = {
      errorCode: "adapter_failed",
      resultJson: {
        turn_exit_reason: "run_request_budget_exhausted",
        conversationContinuation: "continue_conversation_v1",
      },
    } as Pick<Run, "errorCode" | "resultJson">;

    expect(predecessorRetryPolicyAllows(persisted)).toBe(false);
    expect(predecessorRetryAuthorityAllows(persisted)).toBe(false);
  });

  it.each(["queued", "running", "scheduled_retry", "unknown"])(
    "rejects settled but nonterminal predecessor %s", async (status) => {
      const run = await settled();
      expect(await eligible(await update(run, { status }))).toBe(false);
    },
  );

  it("rejects terminal status without durable completion", async () => {
    const run = await settled();
    expect(await eligible(await update(run, { finishedAt: null }))).toBe(false);
  });

  it("rereads current predecessor rather than trusting a stale terminal projection", async () => {
    const run = await settled();
    await update(run, { status: "running", finishedAt: null });
    expect(await eligible(run)).toBe(false);
  });

  it("rejects a predecessor that no longer exists", async () => {
    const run = await settled();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await eligible(run)).toBe(false);
  });

  it.each([{}, { issueId: "" }, { taskId: randomUUID() }])(
    "does not infer independent authorization from absent managed issue attribution %j", async (contextSnapshot) => {
      const run = await settled();
      expect(await eligible(await update(run, { contextSnapshot }))).toBe(false);
    },
  );

  it("rejects contradictory native and context issue identities", async () => {
    const run = await settled();
    const [other] = await db.insert(issues).values({ companyId: run.companyId, title: "Other" }).returning();
    expect(await eligible(await update(run, { nativeIssueId: other!.id }))).toBe(false);
  });

  it("rejects a missing predecessor reservation", async () => {
    expect(await eligible(await fixture())).toBe(false);
  });

  it("rejects uncertain settlement despite optimistic result metadata", async () => {
    const run = await fixture();
    await seedSyntheticCompanyBudgets(db, run.companyId);
    const scope = { companyId: run.companyId, agentId: run.agentId,
      issueId: run.contextSnapshot!.issueId as string, runId: run.id };
    await reserveAutonomousBudget(db, { ...scope, provider: "fixture", model: "fixture" });
    await reconcileAutonomousBudget(db, { ...scope, providerActivityOccurred: true,
      providerRequestId: null, actual: null });
    expect(await eligible(await update(run, { resultJson: {
      budgetSettlement: { status: "reconciled", settlementState: "consumed" },
    } }))).toBe(false);
  });

  it("rejects durable call evidence attributed to another run", async () => {
    const run = await settled();
    expect(await eligible(await update(run, { resultJson: {
      durableCallEvidence: {
        runId: randomUUID(),
        complete: true,
        terminalDiscrepancies: [],
      },
    } }))).toBe(false);
  });

  it("rejects malformed durable evidence even when attributed to the same run", async () => {
    const run = await settled();
    expect(await eligible(await update(run, { resultJson: {
      durableCallEvidence: {
        status: "complete", source: "untrusted", contractVersion: 1, runId: run.id,
        complete: true, iterationAttempts: 1, providerDispatches: 1,
        confirmedResponses: 1, pretransportDenials: 0, unknownOutcomes: 0,
        requestCount: 1, inputTokens: 1, outputTokens: 1,
        providerRequestIds: [`synthetic-retry-receipt:${run.id}`], estimatedCostUsd: 0.000001,
        terminalDiscrepancies: [],
      },
    } }))).toBe(false);
  });

  it.each([
    { usageJson: { inputTokens: 2, outputTokens: 1 } },
    { resultJson: { budgetSettlement: { settlementState: "uncertain_requires_reconciliation" } } },
    { resultJson: { durableCallEvidence: { complete: false, terminalDiscrepancies: ["missing receipt"] } } },
    { resultJson: { pretransportEvidence: { boundary: "never_crossed", complete: true } } },
  ])("rejects contradictory run evidence %j", async (change) => {
    const run = await settled();
    expect(await eligible(await update(run, change))).toBe(false);
  });

  it("does not accept a zero-release label without positive transport-owner evidence", async () => {
    const run = await fixture();
    await zeroRelease(run);
    expect(await eligible(run)).toBe(false);
  });

  it("rejects legacy exact-run never-crossed evidence for successor authority", async () => {
    const run = await fixture();
    await zeroRelease(run);
    const changed = await update(run, { errorCode: "managed_progress_policy_invalid", resultJson: {
      turn_exit_reason: "managed_progress_policy_invalid", successfulProviderResponses: 0,
      pretransportEvidence: { version: 1, source: "hermes_sqlite_transport_owner", runId: run.id,
        sessionId: "fixture-session", attestationId: "fixture-attestation", startedAt: 1, sealedAt: 2,
        boundary: "never_crossed", complete: true, terminalReason: "managed_progress_policy_invalid" },
    } });
    expect(await eligible(changed)).toBe(false);
  });
});
