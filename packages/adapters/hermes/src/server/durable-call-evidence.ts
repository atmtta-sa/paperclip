import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

type Row = Record<string, SQLOutputValue>;
type TerminalUsage = {
  provider_input_tokens?: number | null;
  output_tokens?: number | null;
  successful_provider_responses?: number;
};
export type DurableHermesCallEvidence = {
  runId: string;
  complete: boolean;
  requestCount: number;
  confirmedResponses: number;
  inputTokens: number;
  outputTokens: number;
  providerRequestIds: string[];
  estimatedCostUsd: number | null;
  externalBillingVerified: false;
  rateCardSnapshots: Record<string, unknown>[];
  terminalDiscrepancies: string[];
};

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
function summarize(runId: string, attempts: Row[], calls: Row[], terminal?: TerminalUsage | null): DurableHermesCallEvidence {
  const validCalls = calls.filter((row) => nonNegativeInteger(row.input_tokens) &&
    nonNegativeInteger(row.output_tokens) && typeof row.provider_request_id === "string" &&
    row.provider_request_id.trim().length > 0);
  const snapshots = attempts.map(pricingSnapshot);
  const inputTokens = validCalls.reduce((sum, row) => sum + Number(row.input_tokens), 0);
  const outputTokens = validCalls.reduce((sum, row) => sum + Number(row.output_tokens), 0);
  const providerRequestIds = validCalls.map((row) => String(row.provider_request_id));
  const totalsSafe = Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens);
  const identitiesUnique = new Set(providerRequestIds).size === providerRequestIds.length;
  const complete = attempts.every((row) => row.state === "completed") &&
    calls.length === attempts.length && validCalls.length === calls.length && totalsSafe &&
    identitiesUnique && snapshots.every((value) => value !== null);
  const aggregateCostUsd = calls.reduce((sum, row) => sum + Number(row.cost_usd), 0);
  const costsKnown = complete && calls.every((row) => typeof row.cost_usd === "number" &&
    Number.isFinite(row.cost_usd) && row.cost_usd >= 0) && Number.isFinite(aggregateCostUsd);
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
    runId, complete, requestCount: attempts.length, confirmedResponses: validCalls.length,
    inputTokens, outputTokens,
    providerRequestIds,
    estimatedCostUsd: costsKnown ? aggregateCostUsd : null,
    externalBillingVerified: false,
    rateCardSnapshots: snapshots.filter((value): value is Record<string, unknown> => value !== null),
    terminalDiscrepancies,
  };
}

/** Read one transaction snapshot from the validated profile; never migrate or create a store. */
export function readDurableHermesCallEvidence(
  profileHome: string, runId: string, terminal?: TerminalUsage | null,
): DurableHermesCallEvidence | null {
  let db: DatabaseSync | undefined;
  try {
    const target = path.join(profileHome, "state.db");
    if (!runId || !lstatSync(target).isFile() ||
        path.dirname(realpathSync(target)) !== realpathSync(profileHome)) return null;
    db = new DatabaseSync(target, { readOnly: true });
    db.exec("BEGIN");
    const attempts = db.prepare(
      "SELECT * FROM provider_transport_attempts WHERE execution_run_id = ? ORDER BY started_at, attempt_id LIMIT 10001",
    ).all(runId);
    if (attempts.length === 0 || attempts.length > 10000) return null;
    const calls = db.prepare(`SELECT u.* FROM provider_call_usage u
      JOIN provider_transport_attempts t ON t.session_id = u.session_id AND t.sequence = u.sequence
      AND t.provider_request_id = u.provider_request_id AND t.provider = u.provider
      AND t.model = u.model AND t.billing_base_url = u.billing_base_url
      WHERE t.execution_run_id = ? ORDER BY t.started_at, t.attempt_id LIMIT 10001`).all(runId);
    const result = summarize(runId, attempts, calls, terminal);
    db.exec("COMMIT");
    return result;
  } catch { return null; }
  finally { db?.close(); }
}
