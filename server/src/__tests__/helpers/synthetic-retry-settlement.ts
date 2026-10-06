import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { reserveAutonomousBudget } from "../../services/autonomous-budget-reservations.js";
import { reconcileAutonomousBudget } from "../../services/autonomous-budget-reconciliation.js";
import { seedSyntheticCompanyBudgets } from "./synthetic-autonomous-budgets.js";

/**
 * Explicit accounting-owner fixture for scheduling tests only. No adapter/transport
 * is invoked. Usage and monetary amount are synthetic; external provider charge: none.
 * This does NOT establish Hermes attestation, billing verification or integrated proof.
 */
export async function settleSyntheticRetryPredecessor(
  db: Db,
  runId: string,
  authority: { basis: "synthetic_completed_request" },
) {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(authority.basis, "synthetic_completed_request");
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  assert.ok(run, "Synthetic predecessor must already exist");
  const executionRecovery = run.resultJson?.executionRecovery as
    | { providerWorkStarted?: unknown }
    | undefined;
  assert.equal(
    executionRecovery?.providerWorkStarted,
    true,
    "Synthetic consumed settlement requires an explicit provider-started fixture",
  );
  const issueId = run.nativeIssueId ?? run.contextSnapshot?.issueId;
  assert.equal(typeof issueId, "string");
  const scope = { companyId: run.companyId, agentId: run.agentId, issueId: issueId as string, runId };
  await seedSyntheticCompanyBudgets(db, run.companyId);
  const admission = await reserveAutonomousBudget(db, {
    ...scope, provider: "synthetic_retry_fixture", model: "fixture-model",
  });
  assert.equal(admission.admitted, true);
  const settlement = await reconcileAutonomousBudget(db, {
    ...scope, providerActivityOccurred: true,
    providerRequestId: `synthetic-retry-receipt:${runId}`,
    actual: { requestCount: 1, inputTokens: 1, outputTokens: 1, runtimeMs: 1, costMicrousd: 1 },
    provider: "synthetic_retry_fixture", model: "fixture-model", rateCardVersion: "component-fixture-v1",
  });
  assert.equal(settlement.status, "reconciled");
  assert.equal(settlement.settlementState, "partially_consumed");
  return settlement;
}
