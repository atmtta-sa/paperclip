import type { SQLOutputValue } from "node:sqlite";
import type {
  DurableHermesCallEvidence,
  HermesBillingRoutePolicy,
} from "./durable-call-evidence.js";

type Row = Record<string, SQLOutputValue>;
type TerminalUsage = {
  provider_input_tokens?: number | null;
  output_tokens?: number | null;
  successful_provider_responses?: number;
};

const TOKEN_BASIS = "provider_reported_tokens_v1";

function safeInteger(value: SQLOutputValue): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function completedLifecycle(row: Row): boolean {
  return row.state === "completed" && row.dispatched_at != null && row.completed_at != null &&
    row.denial_reason == null && typeof row.provider_request_id === "string" &&
    row.provider_request_id.trim().length > 0;
}

function deniedLifecycle(row: Row): boolean {
  return row.state === "denied_pretransport" && row.dispatched_at == null &&
    row.completed_at != null && row.provider_request_id == null &&
    typeof row.denial_reason === "string" && row.denial_reason.trim().length > 0;
}

function callMatchesAttempt(call: Row, attempt: Row | undefined): boolean {
  return attempt?.state === "completed" && call.session_id === attempt.session_id &&
    call.sequence === attempt.sequence && call.provider_request_id === attempt.provider_request_id &&
    call.provider === attempt.provider && call.model === attempt.model &&
    call.billing_base_url === attempt.billing_base_url;
}

function activePolicy(policy: HermesBillingRoutePolicy | undefined, now: Date): boolean {
  if (!policy || policy.status !== "active" ||
      !Number.isSafeInteger(policy.policyVersion) || policy.policyVersion < 1 ||
      !Number.isSafeInteger(policy.maxRootChainProviderRequests) ||
      policy.maxRootChainProviderRequests < 1 || !/^[a-f0-9]{64}$/.test(policy.policyDigest)) return false;
  const from = Date.parse(policy.validFrom);
  const until = Date.parse(policy.validUntil);
  return Number.isFinite(from) && Number.isFinite(until) && from <= now.getTime() && now.getTime() < until;
}

function policyMatchesAttempt(
  policy: HermesBillingRoutePolicy | undefined,
  attempt: Row,
  now: Date,
): policy is HermesBillingRoutePolicy {
  return activePolicy(policy, now) && policy!.billingMode === "subscription_included" &&
    attempt.route_policy_id === policy!.policyId &&
    attempt.route_policy_version === policy!.policyVersion &&
    attempt.route_policy_digest === policy!.policyDigest &&
    attempt.provider === policy!.provider && attempt.billing_base_url === policy!.route &&
    attempt.credential_principal_id === policy!.credentialPrincipalId &&
    typeof attempt.model === "string" && policy!.modelScope.includes(attempt.model);
}

function terminalDiscrepancies(
  terminal: TerminalUsage | null | undefined,
  inputTokens: number,
  outputTokens: number,
  responses: number,
): string[] {
  const discrepancies: string[] = [];
  const checks = [
    ["input_tokens", terminal?.provider_input_tokens, inputTokens],
    ["output_tokens", terminal?.output_tokens, outputTokens],
    ["successful_provider_responses", terminal?.successful_provider_responses, responses],
  ] as const;
  for (const [name, reported, durable] of checks) {
    if (reported != null && reported !== durable) discrepancies.push(name);
  }
  return discrepancies;
}

export function summarizeV3(
  runId: string,
  attempts: Row[],
  calls: Row[],
  policy: HermesBillingRoutePolicy | undefined,
  now: Date,
  terminal?: TerminalUsage | null,
): DurableHermesCallEvidence {
  const completed = attempts.filter((row) => row.state === "completed");
  const denials = attempts.filter((row) => row.state === "denied_pretransport");
  const dispatched = attempts.filter((row) => row.dispatched_at != null);
  const unknown = attempts.filter((row) => !completedLifecycle(row) && !deniedLifecycle(row));
  const attemptsById = new Map(attempts.map((row) => [String(row.attempt_id), row]));
  const validCalls = calls.filter((call) => safeInteger(call.input_tokens) &&
    safeInteger(call.output_tokens) &&
    ((safeInteger(call.runtime_ms) && call.runtime_basis === "confirmed_provider_call_ms_v1") ||
      (call.runtime_ms == null && call.runtime_basis == null &&
       call.runtime_applicability === "unavailable_by_route")) &&
    call.token_accounting_basis === TOKEN_BASIS &&
    callMatchesAttempt(call, attemptsById.get(String(call.attempt_id))));
  const inputTokens = validCalls.reduce((total, row) => total + Number(row.input_tokens), 0);
  const outputTokens = validCalls.reduce((total, row) => total + Number(row.output_tokens), 0);
  const runtimeAvailable = validCalls.every((row) => safeInteger(row.runtime_ms));
  const runtimeRepresentations = new Set(validCalls.map((row) =>
    safeInteger(row.runtime_ms) ? "measured" : "unavailable_by_route"));
  const runtimeRepresentationUniform = runtimeRepresentations.size <= 1;
  const providerRuntimeMs = runtimeAvailable
    ? validCalls.reduce((total, row) => total + Number(row.runtime_ms), 0) : null;
  const providerRequestIds = validCalls.map((row) => String(row.provider_request_id));
  const lifecycleComplete = attempts.length > 0 && attempts.every((row) =>
    completedLifecycle(row) || deniedLifecycle(row));
  const executionComplete = lifecycleComplete && unknown.length === 0 &&
    completed.length === dispatched.length && calls.length === completed.length &&
    validCalls.length === calls.length && new Set(providerRequestIds).size === providerRequestIds.length &&
    Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) &&
    (providerRuntimeMs === null || Number.isSafeInteger(providerRuntimeMs)) &&
    runtimeRepresentationUniform;
  const modes = new Set([
    ...attempts.map((row) => String(row.billing_mode)),
    ...calls.map((row) => String(row.billing_mode)),
  ]);
  const billingAggregation = modes.size === 1 ? "single_mode" : "unsupported_mixed_mode";
  const subscriptionShape = modes.size === 1 && modes.has("subscription_included") &&
    attempts.every((row) => row.charge_applicability === "not_applicable_per_request" &&
      row.token_accounting_basis === TOKEN_BASIS && policyMatchesAttempt(policy, row, now)) &&
    calls.every((row) => row.charge_applicability === "not_applicable_per_request" &&
      row.monetary_amount_microusd == null && row.monetary_currency == null &&
      row.cost_microusd == null && row.cost_basis == null && row.cost_authority == null &&
      row.cost_authority_ref == null && row.token_accounting_basis === TOKEN_BASIS);
  const discrepancies = terminalDiscrepancies(
    terminal, inputTokens, outputTokens, validCalls.length,
  );
  const complete = executionComplete && subscriptionShape && discrepancies.length === 0;
  const first = attempts[0];
  return {
    status: complete ? "complete" : "incomplete",
    source: "hermes_sqlite_transport_owner",
    contractVersion: 3,
    runId,
    complete,
    executionComplete,
    iterationAttempts: attempts.length,
    providerDispatches: dispatched.length,
    confirmedResponses: validCalls.length,
    pretransportDenials: denials.length,
    rejectedAfterDispatch: attempts.filter((row) => row.state === "rejected_after_dispatch").length,
    unknownOutcomes: unknown.length,
    requestCount: complete ? dispatched.length : 0,
    inputTokens,
    outputTokens,
    providerRequestIds,
    estimatedCostUsd: null,
    providerRuntimeMs: complete ? providerRuntimeMs : null,
    runtimeBasis: complete && providerRuntimeMs !== null ? "confirmed_provider_call_ms_v1" : null,
    runtimeApplicability: complete && providerRuntimeMs === null ? "unavailable_by_route" : null,
    costMicrousd: null,
    costBasis: complete ? "subscription_included" : null,
    costAuthority: complete ? "subscription_route_policy" : null,
    costAuthorityRef: complete ? `${policy!.policyId}:${policy!.policyVersion}` : null,
    rateCardSnapshots: [],
    terminalDiscrepancies: discrepancies,
    billingMode: modes.size === 1 ? [...modes][0] as DurableHermesCallEvidence["billingMode"] : null,
    billingAggregation,
    chargeApplicability: complete ? "not_applicable_per_request" : null,
    monetaryAmountMicrousd: null,
    monetaryCurrency: null,
    tokenAccountingBasis: complete ? TOKEN_BASIS : null,
    routePolicyId: complete ? String(first?.route_policy_id) : null,
    routePolicyVersion: complete ? Number(first?.route_policy_version) : null,
    routePolicyDigest: complete ? String(first?.route_policy_digest) : null,
    credentialPrincipalId: complete ? String(first?.credential_principal_id) : null,
    rootChainRequestLimit: complete ? policy!.maxRootChainProviderRequests : null,
  };
}
