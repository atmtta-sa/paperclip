import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

type Row = Record<string, SQLOutputValue>;
type TerminalUsage = {
  provider_input_tokens?: number | null;
  output_tokens?: number | null;
  successful_provider_responses?: number;
};
export type DurableHermesEvidenceStatus =
  | "complete"
  | "incomplete"
  | "schema_missing"
  | "no_exact_run_rows"
  | "read_failed"
  | "contract_version_mismatch";
export type DurableHermesCallEvidence = {
  status: DurableHermesEvidenceStatus;
  source: "hermes_sqlite_transport_owner";
  contractVersion: number | null;
  runId: string;
  complete: boolean;
  iterationAttempts: number;
  providerDispatches: number;
  confirmedResponses: number;
  pretransportDenials: number;
  unknownOutcomes: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  providerRequestIds: string[];
  estimatedCostUsd: number | null;
  providerRuntimeMs: number | null;
  runtimeBasis: "confirmed_provider_call_ms_v1" | null;
  costMicrousd: number | null;
  costBasis: "provider_actual" | "subscription_included" | "pretransport_zero" | null;
  costAuthority: "provider_usage_response" | "openai_codex_authenticated_subscription" |
    "transport_owner_never_crossed" | null;
  costAuthorityRef: string | null;
  rateCardSnapshots: Record<string, unknown>[];
  terminalDiscrepancies: string[];
};

const CONTRACT_VERSION = 2;
const SOURCE = "hermes_sqlite_transport_owner" as const;
function nonNegativeInteger(value: SQLOutputValue): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function pricingSnapshot(row: Row): Record<string, unknown> | null {
  try {
    const value = JSON.parse(String(row.pricing_json));
    return value && value.currency === "USD" &&
      typeof value.rate_card_id === "string" && /^[a-f0-9]{64}$/.test(value.rate_card_id)
      ? value : null;
  } catch { return null; }
}
function outcome(runId: string, status: DurableHermesEvidenceStatus,
  contractVersion: number | null = null): DurableHermesCallEvidence {
  return { status, source: SOURCE, contractVersion, runId, complete: false,
    iterationAttempts: 0, providerDispatches: 0, confirmedResponses: 0,
    pretransportDenials: 0, unknownOutcomes: 0, requestCount: 0,
    inputTokens: 0, outputTokens: 0, providerRequestIds: [], estimatedCostUsd: null,
    providerRuntimeMs: null, runtimeBasis: null, costMicrousd: null,
    costBasis: null, costAuthority: null, costAuthorityRef: null,
    rateCardSnapshots: [], terminalDiscrepancies: [] };
}
function validAuthority(row: Row): boolean {
  const ref = typeof row.cost_authority_ref === "string" ? row.cost_authority_ref.trim() : "";
  return row.cost_basis === "provider_actual" &&
    row.cost_authority === "provider_usage_response" &&
    ref === String(row.provider_request_id) && nonNegativeInteger(row.cost_microusd);
}
function validTerminalLifecycle(row: Row): boolean {
  if (row.state === "completed") {
    return row.dispatched_at != null && row.completed_at != null && row.denial_reason == null &&
      typeof row.provider_request_id === "string" && row.provider_request_id.trim().length > 0;
  }
  if (row.state === "denied_pretransport") {
    return row.dispatched_at == null && row.completed_at != null && row.provider_request_id == null &&
      typeof row.denial_reason === "string" && row.denial_reason.trim().length > 0;
  }
  return false;
}
function callMatchesAttempt(call: Row, attempt: Row | undefined): boolean {
  return attempt?.state === "completed" &&
    call.session_id === attempt.session_id && call.sequence === attempt.sequence &&
    call.provider_request_id === attempt.provider_request_id && call.provider === attempt.provider &&
    call.model === attempt.model && call.billing_base_url === attempt.billing_base_url;
}
function summarize(runId: string, attempts: Row[], calls: Row[],
  terminal?: TerminalUsage | null): DurableHermesCallEvidence {
  const contractVersion = Number(attempts[0]?.contract_version ?? CONTRACT_VERSION);
  const contractVersionsValid = attempts.every((row) => row.contract_version === CONTRACT_VERSION);
  const completed = attempts.filter((row) => row.state === "completed");
  const denials = attempts.filter((row) => row.state === "denied_pretransport");
  const dispatched = attempts.filter((row) => row.dispatched_at != null);
  const unknown = attempts.filter((row) =>
    ["dispatched", "failed_after_dispatch", "outcome_unknown"].includes(String(row.state)));
  const attemptsById = new Map(attempts.map((row) => [String(row.attempt_id), row]));
  const validCalls = calls.filter((row) => nonNegativeInteger(row.input_tokens) &&
    nonNegativeInteger(row.output_tokens) && typeof row.provider_request_id === "string" &&
    row.provider_request_id.trim().length > 0 && nonNegativeInteger(row.runtime_ms) &&
    row.runtime_basis === "confirmed_provider_call_ms_v1" && validAuthority(row) &&
    callMatchesAttempt(row, attemptsById.get(String(row.attempt_id))));
  const snapshots = attempts.map(pricingSnapshot);
  const inputTokens = validCalls.reduce((sum, row) => sum + Number(row.input_tokens), 0);
  const outputTokens = validCalls.reduce((sum, row) => sum + Number(row.output_tokens), 0);
  const providerRequestIds = validCalls.map((row) => String(row.provider_request_id));
  const providerRuntimeMs = validCalls.reduce((sum, row) => sum + Number(row.runtime_ms), 0);
  const costMicrousd = validCalls.reduce((sum, row) => sum + Number(row.cost_microusd), 0);
  const totalsSafe = Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens);
  const identitiesUnique = new Set(providerRequestIds).size === providerRequestIds.length;
  const lifecycleComplete = attempts.every(validTerminalLifecycle);
  const authoritiesConsistent = validCalls.every((row) =>
    row.cost_basis === validCalls[0]?.cost_basis && row.cost_authority === validCalls[0]?.cost_authority);
  const deniedBeforeTransport = attempts.length > 0 && denials.length === attempts.length &&
    dispatched.length === 0 && calls.length === 0;
  const complete = contractVersionsValid && lifecycleComplete && unknown.length === 0 &&
    completed.length === dispatched.length && calls.length === completed.length &&
    validCalls.length === calls.length && totalsSafe && identitiesUnique &&
    Number.isSafeInteger(providerRuntimeMs) && Number.isSafeInteger(costMicrousd) &&
    authoritiesConsistent && snapshots.every((value) => value !== null);
  const aggregateEstimatedCostUsd = calls.reduce(
    (sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0,
  );
  const estimatesValid = calls.every((row) => row.estimated_cost_usd == null ||
    typeof row.estimated_cost_usd === "number" && Number.isFinite(row.estimated_cost_usd) &&
    row.estimated_cost_usd >= 0) && Number.isFinite(aggregateEstimatedCostUsd);
  const terminalDiscrepancies: string[] = [];
  const checks = [
    ["input_tokens", terminal?.provider_input_tokens, inputTokens],
    ["output_tokens", terminal?.output_tokens, outputTokens],
    ["successful_provider_responses", terminal?.successful_provider_responses, validCalls.length],
  ] as const;
  for (const [name, reported, durable] of checks) {
    if (reported != null && reported !== durable) terminalDiscrepancies.push(name);
  }
  return {
    status: complete ? "complete" : "incomplete", source: SOURCE, contractVersion,
    runId, complete, iterationAttempts: attempts.length,
    providerDispatches: dispatched.length, confirmedResponses: validCalls.length,
    pretransportDenials: denials.length, unknownOutcomes: unknown.length,
    requestCount: complete ? dispatched.length : 0, inputTokens, outputTokens,
    providerRequestIds, estimatedCostUsd: complete && estimatesValid ? aggregateEstimatedCostUsd : null,
    providerRuntimeMs: complete ? providerRuntimeMs : null,
    runtimeBasis: complete ? "confirmed_provider_call_ms_v1" : null,
    costMicrousd: complete ? costMicrousd : null,
    costBasis: complete && deniedBeforeTransport ? "pretransport_zero" : complete
      ? validCalls[0]?.cost_basis as DurableHermesCallEvidence["costBasis"] : null,
    costAuthority: complete && deniedBeforeTransport ? "transport_owner_never_crossed" : complete
      ? validCalls[0]?.cost_authority as DurableHermesCallEvidence["costAuthority"] : null,
    costAuthorityRef: complete && deniedBeforeTransport ? `exact-run-denial:${runId}` :
      complete && validCalls.length === 1 ? String(validCalls[0]?.cost_authority_ref) :
        complete ? "multiple_exact_request_refs" : null,
    rateCardSnapshots: snapshots.filter((value): value is Record<string, unknown> => value !== null),
    terminalDiscrepancies,
  };
}

/** Read one transaction snapshot from the validated profile; never migrate or create a store. */
export function readDurableHermesCallEvidence(
  profileHome: string, runId: string, terminal?: TerminalUsage | null,
): DurableHermesCallEvidence {
  let db: DatabaseSync | undefined;
  try {
    const target = path.join(profileHome, "state.db");
    if (!runId || !lstatSync(target).isFile() ||
        path.dirname(realpathSync(target)) !== realpathSync(profileHome)) return outcome(runId, "read_failed");
    db = new DatabaseSync(target, { readOnly: true });
    db.exec("BEGIN");
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('state_meta', 'provider_transport_attempts', 'provider_call_usage')`).all();
    if (tables.length !== 3) return outcome(runId, "schema_missing");
    const marker = db.prepare(
      "SELECT value FROM state_meta WHERE key = 'provider_evidence_contract_version'",
    ).get() as Row | undefined;
    const contractVersion = marker ? Number(marker.value) : null;
    if (contractVersion !== CONTRACT_VERSION) {
      return outcome(runId, "contract_version_mismatch", contractVersion);
    }
    const attempts = db.prepare(
      "SELECT * FROM provider_transport_attempts WHERE execution_run_id = ? ORDER BY started_at, attempt_id LIMIT 10001",
    ).all(runId);
    if (attempts.length === 0) return outcome(runId, "no_exact_run_rows", contractVersion);
    if (attempts.length > 10000) return outcome(runId, "incomplete", contractVersion);
    const calls = db.prepare(`SELECT u.* FROM provider_call_usage u
      JOIN provider_transport_attempts t ON t.attempt_id = u.attempt_id
      WHERE t.execution_run_id = ? ORDER BY t.started_at, t.attempt_id LIMIT 10001`).all(runId);
    const result = summarize(runId, attempts, calls, terminal);
    db.exec("COMMIT");
    return result;
  } catch { return outcome(runId, "read_failed"); }
  finally { db?.close(); }
}
