import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDurableHermesCallEvidence } from "./durable-call-evidence.js";

// COM-275 bounded provider-attempt evidence semantics. The per-run allowance
// is four provider requests; any attempt that crossed the transport boundary
// (completed, failed_after_dispatch, outcome_unknown) conservatively consumes
// one request. A denial proven before transport does not.

const subscriptionPolicy = {
  policyId: "codex-subscription-route",
  policyVersion: 1,
  policyDigest: "b".repeat(64),
  provider: "openai-codex",
  route: "https://chatgpt.com/backend-api/codex",
  credentialPrincipalId: "managed-account:codex-uat",
  modelScope: ["gpt-5.6-codex"],
  billingMode: "subscription_included" as const,
  status: "active" as const,
  validFrom: "2026-10-01T00:00:00.000Z",
  validUntil: "2026-11-01T00:00:00.000Z",
  maxRootChainProviderRequests: 12,
};

const PER_RUN_ALLOWANCE = 4;

type AttemptSpec =
  | { kind: "completed"; requestId: string }
  | { kind: "outcome_unknown" }
  | { kind: "denied_pretransport" };

function fixture(runId: string, attempts: AttemptSpec[]) {
  const home = mkdtempSync(path.join(tmpdir(), "hermes-budget-sufficiency-test-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(`CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO state_meta VALUES ('provider_evidence_contract_version', '3');
    CREATE TABLE provider_transport_attempts (
      attempt_id TEXT PRIMARY KEY, contract_version INTEGER, execution_run_id TEXT,
      session_id TEXT, sequence INTEGER, iteration_attempt INTEGER, state TEXT,
      provider_request_id TEXT, provider TEXT, model TEXT, billing_base_url TEXT,
      pricing_json TEXT, started_at REAL, dispatched_at REAL, completed_at REAL,
      denial_reason TEXT, error_text TEXT, billing_mode TEXT, charge_applicability TEXT,
      route_policy_id TEXT, route_policy_version INTEGER, route_policy_digest TEXT,
      credential_principal_id TEXT, token_accounting_basis TEXT);
    CREATE TABLE provider_call_usage (
      attempt_id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, provider_request_id TEXT,
      provider TEXT, model TEXT, billing_base_url TEXT, input_tokens INTEGER,
      output_tokens INTEGER, runtime_ms INTEGER, runtime_basis TEXT, estimated_cost_usd REAL,
      cost_microusd INTEGER, cost_basis TEXT, cost_authority TEXT, cost_authority_ref TEXT,
      created_at REAL, billing_mode TEXT, charge_applicability TEXT,
      monetary_amount_microusd INTEGER, monetary_currency TEXT, token_accounting_basis TEXT,
      runtime_applicability TEXT);`);
  const insertAttempt = db.prepare(`INSERT INTO provider_transport_attempts
    (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
     provider_request_id,provider,model,billing_base_url,pricing_json,started_at,dispatched_at,completed_at,
     denial_reason,billing_mode,charge_applicability,route_policy_id,route_policy_version,route_policy_digest,
     credential_principal_id,token_accounting_basis)
    VALUES (?,3,?,?,?,?,?,?,'openai-codex','gpt-5.6-codex','https://chatgpt.com/backend-api/codex',
     NULL,?,?,?,?,'subscription_included','not_applicable_per_request',?,?,?,?,?)`);
  const insertCall = db.prepare(`INSERT INTO provider_call_usage
    (attempt_id,session_id,sequence,provider_request_id,provider,model,billing_base_url,input_tokens,
     output_tokens,runtime_ms,runtime_basis,estimated_cost_usd,cost_microusd,cost_basis,cost_authority,
     cost_authority_ref,created_at,billing_mode,charge_applicability,monetary_amount_microusd,
     monetary_currency,token_accounting_basis,runtime_applicability)
    VALUES (?,?,?,?,'openai-codex','gpt-5.6-codex','https://chatgpt.com/backend-api/codex',120,30,
     NULL,NULL,NULL,NULL,'subscription_included','subscription_route_policy',?,
     1,'subscription_included','not_applicable_per_request',NULL,NULL,'provider_reported_tokens_v1',
     'unavailable_by_route')`);
  attempts.forEach((spec, index) => {
    const attemptId = `attempt-${index + 1}`;
    const sequence = index + 1;
    const sessionId = "session-com275";
    if (spec.kind === "completed") {
      insertAttempt.run(attemptId, runId, sessionId, sequence, sequence, "completed",
        spec.requestId, 1, 1, 1, null, subscriptionPolicy.policyId,
        subscriptionPolicy.policyVersion, subscriptionPolicy.policyDigest,
        subscriptionPolicy.credentialPrincipalId, "provider_reported_tokens_v1");
      insertCall.run(attemptId, sessionId, sequence, spec.requestId,
        `${subscriptionPolicy.policyId}:${subscriptionPolicy.policyVersion}:${subscriptionPolicy.policyDigest}`);
    } else if (spec.kind === "outcome_unknown") {
      // Crossed the transport boundary; connection refusal left the outcome
      // unprovable. No call usage row can exist for an unresolved attempt.
      insertAttempt.run(attemptId, runId, sessionId, sequence, sequence, "outcome_unknown",
        null, 1, 1, null, null, subscriptionPolicy.policyId,
        subscriptionPolicy.policyVersion, subscriptionPolicy.policyDigest,
        subscriptionPolicy.credentialPrincipalId, "provider_reported_tokens_v1");
    } else {
      insertAttempt.run(attemptId, runId, sessionId, sequence, sequence, "denied_pretransport",
        null, 1, null, 1, "provider_quota", subscriptionPolicy.policyId,
        subscriptionPolicy.policyVersion, subscriptionPolicy.policyDigest,
        subscriptionPolicy.credentialPrincipalId, "provider_reported_tokens_v1");
    }
  });
  db.close();
  return home;
}

function evidenceFor(runId: string, attempts: AttemptSpec[]) {
  return readDurableHermesCallEvidence(
    fixture(runId, attempts), runId, null, subscriptionPolicy,
  );
}

describe("bounded provider-attempt evidence (COM-275)", () => {
  it("counts three completed requests plus one outcome_unknown as an exhausted four-request allowance", () => {
    const evidence = evidenceFor("run-exhausted", [
      { kind: "completed", requestId: "req-1" },
      { kind: "completed", requestId: "req-2" },
      { kind: "completed", requestId: "req-3" },
      { kind: "outcome_unknown" },
    ]);
    expect(evidence).toMatchObject({
      status: "incomplete",
      complete: false,
      providerDispatches: PER_RUN_ALLOWANCE,
      confirmedResponses: 3,
      unknownOutcomes: 1,
      pretransportDenials: 0,
    });
    // Conservative accounting: the uncertain post-dispatch attempt consumed one
    // of the four admitted requests; nothing remains for a fifth dispatch.
    expect(evidence.providerDispatches).toBeGreaterThanOrEqual(PER_RUN_ALLOWANCE);
  });

  it("records the COM-275 five-attempt sequence with the fifth dispatch beyond the admitted allowance", () => {
    // 3 completed + 1 outcome_unknown (connection refusal) + 1 automatic retry
    // that completed. The retry crossed the boundary after the allowance was
    // exhausted; the evidence preserves every attempt and can never settle.
    const evidence = evidenceFor("run-com275", [
      { kind: "completed", requestId: "req-1" },
      { kind: "completed", requestId: "req-2" },
      { kind: "completed", requestId: "req-3" },
      { kind: "outcome_unknown" },
      { kind: "completed", requestId: "req-5-retry" },
    ]);
    expect(evidence).toMatchObject({
      status: "incomplete",
      complete: false,
      providerDispatches: 5,
      confirmedResponses: 4,
      unknownOutcomes: 1,
      requestCount: 0,
    });
    expect(evidence.providerDispatches).toBeGreaterThan(PER_RUN_ALLOWANCE);
    // Incomplete evidence is not settlement authority: no route-policy fields.
    expect(evidence.routePolicyId).toBeNull();
    expect(evidence.rootChainRequestLimit).toBeNull();
  });

  it("counts four completed requests as an exhausted allowance with settleable evidence", () => {
    const evidence = evidenceFor("run-four-complete", [
      { kind: "completed", requestId: "req-1" },
      { kind: "completed", requestId: "req-2" },
      { kind: "completed", requestId: "req-3" },
      { kind: "completed", requestId: "req-4" },
    ]);
    expect(evidence).toMatchObject({
      status: "complete",
      complete: true,
      providerDispatches: PER_RUN_ALLOWANCE,
      confirmedResponses: PER_RUN_ALLOWANCE,
      unknownOutcomes: 0,
      requestCount: PER_RUN_ALLOWANCE,
    });
  });

  it("does not consume the allowance for a denial proven before transport", () => {
    const evidence = evidenceFor("run-denied", [
      { kind: "completed", requestId: "req-1" },
      { kind: "denied_pretransport" },
    ]);
    expect(evidence).toMatchObject({
      providerDispatches: 1,
      pretransportDenials: 1,
      confirmedResponses: 1,
      unknownOutcomes: 0,
    });
    expect(evidence.providerDispatches).toBeLessThan(PER_RUN_ALLOWANCE);
  });

  it("treats an uncertain post-dispatch attempt as consumed even with no completed calls", () => {
    const evidence = evidenceFor("run-only-unknown", [{ kind: "outcome_unknown" }]);
    expect(evidence).toMatchObject({
      status: "incomplete",
      complete: false,
      providerDispatches: 1,
      confirmedResponses: 0,
      unknownOutcomes: 1,
      requestCount: 0,
    });
  });
});
