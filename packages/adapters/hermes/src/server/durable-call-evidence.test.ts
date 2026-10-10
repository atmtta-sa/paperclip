import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDurableHermesCallEvidence } from "./durable-call-evidence.js";

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

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "hermes-run-evidence-test-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(`CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO state_meta VALUES ('provider_evidence_contract_version', '2');
    CREATE TABLE provider_transport_attempts (
    attempt_id TEXT PRIMARY KEY, contract_version INTEGER, execution_run_id TEXT,
    session_id TEXT, sequence INTEGER, iteration_attempt INTEGER, state TEXT,
    provider_request_id TEXT, provider TEXT, model TEXT, billing_base_url TEXT,
    pricing_json TEXT, started_at REAL, dispatched_at REAL, completed_at REAL,
    denial_reason TEXT, error_text TEXT);
    CREATE TABLE provider_call_usage (
    attempt_id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, provider_request_id TEXT,
    provider TEXT, model TEXT, billing_base_url TEXT, input_tokens INTEGER,
    output_tokens INTEGER, runtime_ms INTEGER, runtime_basis TEXT, estimated_cost_usd REAL,
    cost_microusd INTEGER, cost_basis TEXT, cost_authority TEXT, cost_authority_ref TEXT,
    created_at REAL);`);
  const rate = JSON.stringify({ rate_card_id: "a".repeat(64), currency: "USD" });
  const attempt = db.prepare(`INSERT INTO provider_transport_attempts
    (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
     provider_request_id,provider,model,billing_base_url,pricing_json,started_at,dispatched_at,completed_at)
    VALUES (?,2,?,'shared',?,?,'completed',?,'custom','fixture','http://127.0.0.1:12345/v1',?,1,1,1)`);
  const call = db.prepare(`INSERT INTO provider_call_usage VALUES
    (?,'shared',?,?, 'custom','fixture','http://127.0.0.1:12345/v1',?,20,7,
     'confirmed_provider_call_ms_v1',0.00014,140,'provider_actual','provider_usage_response',?,1)`);
  attempt.run("attempt-A", "run-A", 1, 1, "synthetic-A", rate);
  call.run("attempt-A", 1, "synthetic-A", 100, "synthetic-A");
  attempt.run("attempt-B", "run-B", 2, 1, "synthetic-B", rate);
  call.run("attempt-B", 2, "synthetic-B", 50, "synthetic-B");
  db.close();
  return home;
}

function subscriptionFixture(overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "hermes-run-evidence-v3-test-"));
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
  const values = {
    billingMode: "subscription_included",
    chargeApplicability: "not_applicable_per_request",
    policyId: subscriptionPolicy.policyId,
    policyVersion: subscriptionPolicy.policyVersion,
    policyDigest: "b".repeat(64),
    principal: subscriptionPolicy.credentialPrincipalId,
    tokenBasis: "provider_reported_tokens_v1",
    monetaryAmount: null,
    monetaryCurrency: null,
    costBasis: "subscription_included",
    costAuthority: "subscription_route_policy",
    costAuthorityRef: `${subscriptionPolicy.policyId}:${subscriptionPolicy.policyVersion}:${subscriptionPolicy.policyDigest}`,
    ...overrides,
  };
  db.prepare(`INSERT INTO provider_transport_attempts
    (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
     provider_request_id,provider,model,billing_base_url,pricing_json,started_at,dispatched_at,completed_at,
     billing_mode,charge_applicability,route_policy_id,route_policy_version,route_policy_digest,
     credential_principal_id,token_accounting_basis)
    VALUES ('attempt-sub',3,'run-sub','session-sub',1,1,'completed','response-sub','openai-codex',
     'gpt-5.6-codex','https://chatgpt.com/backend-api/codex',NULL,1,1,1,?,?,?,?,?,?,?)`)
    .run(values.billingMode, values.chargeApplicability, values.policyId, values.policyVersion,
      values.policyDigest, values.principal, values.tokenBasis);
  db.prepare(`INSERT INTO provider_call_usage
    (attempt_id,session_id,sequence,provider_request_id,provider,model,billing_base_url,input_tokens,
     output_tokens,runtime_ms,runtime_basis,estimated_cost_usd,cost_microusd,cost_basis,cost_authority,
     cost_authority_ref,created_at,billing_mode,charge_applicability,monetary_amount_microusd,
     monetary_currency,token_accounting_basis,runtime_applicability)
    VALUES ('attempt-sub','session-sub',1,'response-sub','openai-codex','gpt-5.6-codex',
     'https://chatgpt.com/backend-api/codex',120,30,NULL,NULL,NULL,NULL,?,?,?,
     1,?,?,?,?,?,?)`)
    .run(values.costBasis, values.costAuthority, values.costAuthorityRef,
      values.billingMode, values.chargeApplicability, values.monetaryAmount,
      values.monetaryCurrency, values.tokenBasis, "unavailable_by_route");
  db.close();
  return home;
}

describe("read-only durable managed evidence", () => {
  it("recovers only the exact run from a shared session without terminal output", () => {
    const evidence = readDurableHermesCallEvidence(fixture(), "run-A");
    expect(evidence).toMatchObject({ runId: "run-A", complete: true, contractVersion: 2,
      requestCount: 1, inputTokens: 100, outputTokens: 20,
      providerRuntimeMs: 7, runtimeBasis: "confirmed_provider_call_ms_v1",
      costMicrousd: 140, costBasis: "provider_actual",
      costAuthority: "provider_usage_response", estimatedCostUsd: 0.00014 });
    expect(evidence?.providerRequestIds).toEqual(["synthetic-A"]);
  });
  it("accepts v3 subscription evidence only against the exact active Paperclip route policy", () => {
    const evidence = readDurableHermesCallEvidence(
      subscriptionFixture(), "run-sub", null, subscriptionPolicy,
    );
    expect(evidence).toMatchObject({
      status: "complete", complete: true, contractVersion: 3,
      billingMode: "subscription_included",
      billingAggregation: "single_mode",
      chargeApplicability: "not_applicable_per_request",
      monetaryAmountMicrousd: null,
      monetaryCurrency: null,
      requestCount: 1,
      inputTokens: 120,
      outputTokens: 30,
      providerRuntimeMs: null,
      runtimeBasis: null,
      tokenAccountingBasis: "provider_reported_tokens_v1",
      routePolicyId: subscriptionPolicy.policyId,
      routePolicyVersion: subscriptionPolicy.policyVersion,
      routePolicyDigest: subscriptionPolicy.policyDigest,
      credentialPrincipalId: subscriptionPolicy.credentialPrincipalId,
      rootChainRequestLimit: subscriptionPolicy.maxRootChainProviderRequests,
    });
  });
  it("rejects v3 subscription call authority that drifts from the bound route policy", () => {
    const evidence = readDurableHermesCallEvidence(
      subscriptionFixture({ costAuthorityRef: "other-policy:1:bad" }),
      "run-sub", null, subscriptionPolicy,
    );
    expect(evidence).toMatchObject({ status: "incomplete", complete: false, requestCount: 0 });
  });
  it("preserves strict metered evidence when the store contract is v3", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec(`UPDATE state_meta SET value = '3' WHERE key = 'provider_evidence_contract_version';
      UPDATE provider_transport_attempts SET contract_version = 3;
      ALTER TABLE provider_transport_attempts ADD COLUMN billing_mode TEXT DEFAULT 'metered_currency';
      ALTER TABLE provider_transport_attempts ADD COLUMN charge_applicability TEXT DEFAULT 'charge_applicable';
      ALTER TABLE provider_transport_attempts ADD COLUMN route_policy_id TEXT;
      ALTER TABLE provider_transport_attempts ADD COLUMN route_policy_version INTEGER;
      ALTER TABLE provider_transport_attempts ADD COLUMN route_policy_digest TEXT;
      ALTER TABLE provider_transport_attempts ADD COLUMN credential_principal_id TEXT;
      ALTER TABLE provider_transport_attempts ADD COLUMN token_accounting_basis TEXT DEFAULT 'provider_reported_tokens_v1';
      ALTER TABLE provider_call_usage ADD COLUMN billing_mode TEXT DEFAULT 'metered_currency';
      ALTER TABLE provider_call_usage ADD COLUMN charge_applicability TEXT DEFAULT 'charge_applicable';
      ALTER TABLE provider_call_usage ADD COLUMN monetary_amount_microusd INTEGER DEFAULT 140;
      ALTER TABLE provider_call_usage ADD COLUMN monetary_currency TEXT DEFAULT 'USD';
      ALTER TABLE provider_call_usage ADD COLUMN token_accounting_basis TEXT DEFAULT 'provider_reported_tokens_v1';
      ALTER TABLE provider_call_usage ADD COLUMN runtime_applicability TEXT;`);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "complete", complete: true, contractVersion: 3,
      billingMode: "metered_currency", providerRuntimeMs: 7,
      runtimeBasis: "confirmed_provider_call_ms_v1", costMicrousd: 140,
      costBasis: "provider_actual", costAuthority: "provider_usage_response",
      tokenAccountingBasis: "provider_reported_tokens_v1",
    });
  }, 20_000);
  it("rejects contradictory contract-v3 metered monetary evidence", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec(`UPDATE state_meta SET value = '3' WHERE key = 'provider_evidence_contract_version';
      UPDATE provider_transport_attempts SET contract_version = 3;
      ALTER TABLE provider_transport_attempts ADD COLUMN billing_mode TEXT DEFAULT 'metered_currency';
      ALTER TABLE provider_transport_attempts ADD COLUMN charge_applicability TEXT DEFAULT 'charge_applicable';
      ALTER TABLE provider_transport_attempts ADD COLUMN token_accounting_basis TEXT DEFAULT 'provider_reported_tokens_v1';
      ALTER TABLE provider_call_usage ADD COLUMN billing_mode TEXT DEFAULT 'metered_currency';
      ALTER TABLE provider_call_usage ADD COLUMN charge_applicability TEXT DEFAULT 'charge_applicable';
      ALTER TABLE provider_call_usage ADD COLUMN monetary_amount_microusd INTEGER DEFAULT 999;
      ALTER TABLE provider_call_usage ADD COLUMN monetary_currency TEXT DEFAULT 'EUR';
      ALTER TABLE provider_call_usage ADD COLUMN token_accounting_basis TEXT DEFAULT 'provider_reported_tokens_v1';
      ALTER TABLE provider_call_usage ADD COLUMN runtime_applicability TEXT;`);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "incomplete", complete: false, contractVersion: 3,
    });
  }, 20_000);
  it("rejects mixed measured and unavailable runtime in one subscription run", () => {
    const home = subscriptionFixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec(`INSERT INTO provider_transport_attempts
      SELECT 'attempt-measured',contract_version,execution_run_id,session_id,2,2,state,
      'response-measured',provider,model,billing_base_url,pricing_json,started_at,dispatched_at,
      completed_at,denial_reason,error_text,billing_mode,charge_applicability,route_policy_id,
      route_policy_version,route_policy_digest,credential_principal_id,token_accounting_basis
      FROM provider_transport_attempts WHERE attempt_id = 'attempt-sub';
      INSERT INTO provider_call_usage
      SELECT 'attempt-measured',session_id,2,'response-measured',provider,model,billing_base_url,
      input_tokens,output_tokens,7,'confirmed_provider_call_ms_v1',estimated_cost_usd,cost_microusd,
      cost_basis,cost_authority,cost_authority_ref,created_at,billing_mode,charge_applicability,
      monetary_amount_microusd,monetary_currency,token_accounting_basis,NULL
      FROM provider_call_usage WHERE attempt_id = 'attempt-sub';`);
    db.close();
    expect(readDurableHermesCallEvidence(
      home, "run-sub", null, subscriptionPolicy,
    )).toMatchObject({ status: "incomplete", complete: false, contractVersion: 3 });
  });
  it.each([
    ["missing policy", undefined],
    ["revoked policy", { ...subscriptionPolicy, status: "revoked" as const }],
    ["expired policy", { ...subscriptionPolicy, validUntil: "2026-09-01T00:00:00.000Z" }],
    ["wrong principal", { ...subscriptionPolicy, credentialPrincipalId: "managed-account:other" }],
    ["wrong policy digest", { ...subscriptionPolicy, policyDigest: "c".repeat(64) }],
  ])("rejects subscription evidence with %s", (_name, policy) => {
    expect(readDurableHermesCallEvidence(
      subscriptionFixture(), "run-sub", null, policy, new Date("2026-10-10T00:00:00.000Z"),
    )).toMatchObject({ status: "incomplete", complete: false });
  });
  it.each([
    ["numeric zero money", { monetaryAmount: 0 }],
    ["currency without money", { monetaryCurrency: "USD" }],
    ["wrong applicability", { chargeApplicability: "charge_applicable" }],
    ["unknown token basis", { tokenBasis: "unknown" }],
  ])("rejects subscription evidence containing %s", (_name, overrides) => {
    expect(readDurableHermesCallEvidence(
      subscriptionFixture(overrides), "run-sub", null, subscriptionPolicy,
    )).toMatchObject({ status: "incomplete", complete: false });
  });
  it("keeps a mixed-mode v3 run execution-complete but blocks billing continuation", () => {
    const home = subscriptionFixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec(`UPDATE provider_call_usage SET billing_mode = 'metered_currency',
      charge_applicability = 'charge_applicable', monetary_amount_microusd = 12,
      monetary_currency = 'USD', cost_microusd = 12, cost_basis = 'provider_actual',
      cost_authority = 'provider_usage_response', cost_authority_ref = 'response-sub'`);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-sub", null, subscriptionPolicy)).toMatchObject({
      status: "incomplete", complete: false, executionComplete: true,
      billingAggregation: "unsupported_mixed_mode",
    });
  });
  it("does not certify absent run evidence as zero transport", () => {
    expect(readDurableHermesCallEvidence(fixture(), "missing-run")).toMatchObject({
      status: "no_exact_run_rows", complete: false, requestCount: 0,
    });
  });
  it("does not count a sealed pretransport denial as a provider dispatch", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "d".repeat(64), currency: "USD" });
    db.prepare(`INSERT INTO provider_transport_attempts
      (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
       provider,model,billing_base_url,pricing_json,started_at,completed_at,denial_reason)
      VALUES ('denied',2,'run-A','shared',2,2,'denied_pretransport','custom','fixture','',?,2,2,'policy')`).run(rate);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      complete: true, iterationAttempts: 2, pretransportDenials: 1,
      providerDispatches: 1, requestCount: 1, providerRuntimeMs: 7,
    });
  });
  it("reports a missing contract marker table as schema missing", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec("DROP TABLE state_meta");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "schema_missing", complete: false,
    });
  });
  it("preserves confirmed usage beside an uncertain transport attempt", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "d".repeat(64), currency: "USD" });
    db.prepare(`INSERT INTO provider_transport_attempts
      (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
       provider,model,billing_base_url,pricing_json,started_at,dispatched_at)
      VALUES ('unknown',2,'run-A','shared',2,2,'dispatched','custom','fixture','',?,2,2)`).run(rate);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "incomplete", complete: false, requestCount: 0, providerDispatches: 2,
      unknownOutcomes: 1, confirmedResponses: 1, inputTokens: 100, outputTokens: 20,
      estimatedCostUsd: null,
    });
  });
  it("flags a contradictory terminal total without discarding the ledger", () => {
    expect(readDurableHermesCallEvidence(fixture(), "run-A", {
      provider_input_tokens: 999, output_tokens: 20, successful_provider_responses: 1,
    })).toMatchObject({ inputTokens: 100, terminalDiscrepancies: ["input_tokens"] });
  });
  it("does not complete evidence whose aggregate tokens exceed safe integer range", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "b".repeat(64), currency: "USD" });
    db.prepare("UPDATE provider_call_usage SET input_tokens = ? WHERE provider_request_id = 'synthetic-A'")
      .run(Number.MAX_SAFE_INTEGER);
    db.prepare(`INSERT INTO provider_transport_attempts
      (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
       provider_request_id,provider,model,billing_base_url,pricing_json,started_at,dispatched_at,completed_at)
      VALUES ('attempt-C',2,'run-A','shared',3,3,'completed','synthetic-C','custom','fixture','',?,3,3,3)`)
      .run(rate);
    db.exec("INSERT INTO provider_call_usage VALUES ('attempt-C','shared',3,'synthetic-C','custom','fixture','',1,0,1,'confirmed_provider_call_ms_v1',0.00001,10,'provider_actual','provider_usage_response','synthetic-C',3)");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({ complete: false });
  });
  it("does not complete evidence with an empty provider request identity", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec("UPDATE provider_transport_attempts SET provider_request_id = '' WHERE execution_run_id = 'run-A'; UPDATE provider_call_usage SET provider_request_id = '' WHERE provider_request_id = 'synthetic-A'");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({ complete: false });
  });
  it.each([
    ["session_id", "other-session"],
    ["sequence", 99],
    ["provider_request_id", "other-request"],
    ["provider", "other-provider"],
    ["model", "other-model"],
    ["billing_base_url", "https://other.invalid/v1"],
  ])("rejects usage whose %s disagrees with its owning attempt", (column, value) => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.prepare(`UPDATE provider_call_usage SET ${column} = ? WHERE attempt_id = 'attempt-A'`)
      .run(value);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "incomplete", complete: false,
    });
  });
  it("rejects offsetting per-row lifecycle contradictions", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "e".repeat(64), currency: "USD" });
    db.exec("UPDATE provider_transport_attempts SET dispatched_at = NULL WHERE attempt_id = 'attempt-A'");
    db.prepare(`INSERT INTO provider_transport_attempts
      (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
       provider,model,billing_base_url,pricing_json,started_at,dispatched_at,completed_at,denial_reason)
      VALUES ('denied-offset',2,'run-A','shared',2,2,'denied_pretransport',
       'custom','fixture','',?,2,2,2,'policy')`).run(rate);
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "incomplete", complete: false,
    });
  });
  it("does not complete a run containing a mismatched attempt contract version", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec("UPDATE provider_transport_attempts SET contract_version = 1 WHERE execution_run_id = 'run-A'");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      status: "incomplete", complete: false,
    });
  });
  it("does not emit an infinite aggregate estimated cost", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "c".repeat(64), currency: "USD" });
    db.exec("UPDATE provider_call_usage SET estimated_cost_usd = 1e308 WHERE provider_request_id = 'synthetic-A'");
    db.prepare(`INSERT INTO provider_transport_attempts
      (attempt_id,contract_version,execution_run_id,session_id,sequence,iteration_attempt,state,
       provider_request_id,provider,model,billing_base_url,pricing_json,started_at,dispatched_at,completed_at)
      VALUES ('attempt-D',2,'run-A','shared',4,4,'completed','synthetic-D','custom','fixture','',?,4,4,4)`)
      .run(rate);
    db.exec("INSERT INTO provider_call_usage VALUES ('attempt-D','shared',4,'synthetic-D','custom','fixture','',1,0,1,'confirmed_provider_call_ms_v1',1e308,10,'provider_actual','provider_usage_response','synthetic-D',4)");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({ estimatedCostUsd: null });
  });
});
