import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";

export type ManagedBudgetVerifier = (
  adapterResult: AdapterExecutionResult,
  rawUsage: UsageSummary | null,
  expectedRunId: string,
) => NonNullable<AdapterExecutionResult["budgetTelemetry"]> | null;

export interface ManagedHermesSettlementProvenance {
  source: string;
  contractVersion: number;
  runId: string;
  digestSha256: string;
  costBasis: string;
  runtimeBasis: string | null;
  runtimeApplicability?: string | null;
  billingMode?: string;
  routePolicyId?: string;
  routePolicyVersion?: number;
  routePolicyDigest?: string;
  credentialPrincipalId?: string;
  rootChainRequestLimit?: number;
  tokenAccountingBasis?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function managedHermesEvidenceDigest(evidence: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(evidence)).digest("hex");
}

function authoritativeCostPair(evidence: Record<string, unknown>): boolean {
  return evidence.costBasis === "provider_actual" &&
    evidence.costAuthority === "provider_usage_response";
}

function authoritativeSubscriptionPair(evidence: Record<string, unknown>): boolean {
  return evidence.billingMode === "subscription_included" &&
    evidence.billingAggregation === "single_mode" &&
    evidence.chargeApplicability === "not_applicable_per_request" &&
    evidence.monetaryAmountMicrousd === null && evidence.monetaryCurrency === null &&
    evidence.costMicrousd === null && evidence.estimatedCostUsd === null &&
    evidence.costBasis === "subscription_included" &&
    evidence.costAuthority === "subscription_route_policy" &&
    evidence.tokenAccountingBasis === "provider_reported_tokens_v1" &&
    typeof evidence.routePolicyId === "string" && Boolean(evidence.routePolicyId.trim()) &&
    Number.isSafeInteger(evidence.routePolicyVersion) && (evidence.routePolicyVersion as number) > 0 &&
    typeof evidence.routePolicyDigest === "string" &&
    /^[a-f0-9]{64}$/.test(evidence.routePolicyDigest) &&
    typeof evidence.credentialPrincipalId === "string" &&
    Boolean(evidence.credentialPrincipalId.trim()) &&
    Number.isSafeInteger(evidence.rootChainRequestLimit) &&
    (evidence.rootChainRequestLimit as number) > 0;
}

export function managedHermesSettlementProvenance(
  adapterResult: AdapterExecutionResult,
  expectedRunId: string,
): ManagedHermesSettlementProvenance | null {
  const durable = (adapterResult.resultJson ?? {}).durableCallEvidence;
  if (!durable || typeof durable !== "object" || Array.isArray(durable)) return null;
  const evidence = durable as Record<string, unknown>;
  if (evidence.source !== "hermes_sqlite_transport_owner" ||
      ![2, 3].includes(evidence.contractVersion as number) ||
      evidence.runId !== expectedRunId || evidence.complete !== true ||
      typeof evidence.costBasis !== "string") return null;
  const runtimeAvailable = typeof evidence.runtimeBasis === "string";
  const runtimeUnavailable = evidence.contractVersion === 3 && evidence.runtimeBasis === null &&
    evidence.runtimeApplicability === "unavailable_by_route";
  if (!runtimeAvailable && !runtimeUnavailable) return null;
  const provenance: ManagedHermesSettlementProvenance = {
    source: evidence.source,
    contractVersion: evidence.contractVersion as number,
    runId: expectedRunId,
    digestSha256: managedHermesEvidenceDigest(evidence),
    costBasis: evidence.costBasis,
    runtimeBasis: evidence.runtimeBasis as string | null,
  };
  if (evidence.contractVersion === 3 && evidence.billingMode === "subscription_included") {
    if (!authoritativeSubscriptionPair(evidence)) return null;
    provenance.billingMode = evidence.billingMode as string;
    provenance.routePolicyId = evidence.routePolicyId as string;
    provenance.routePolicyVersion = evidence.routePolicyVersion as number;
    provenance.routePolicyDigest = evidence.routePolicyDigest as string;
    provenance.credentialPrincipalId = evidence.credentialPrincipalId as string;
    provenance.rootChainRequestLimit = evidence.rootChainRequestLimit as number;
    provenance.tokenAccountingBasis = evidence.tokenAccountingBasis as string;
    provenance.runtimeApplicability = (evidence.runtimeApplicability as string | null) ?? null;
  }
  return provenance;
}

/** Production acceptance rules; token completeness is not billing authority. */
export const verifyManagedBudgetEvidence: ManagedBudgetVerifier = (
  adapterResult,
  rawUsage,
  expectedRunId,
) => {
  // An explicit incomplete Hermes result cannot be repaired by a nominal
  // adapter telemetry object; keep the reservation until reconciliation.
  const resultEvidence = (adapterResult.resultJson ?? {});
  const durable = resultEvidence.durableCallEvidence;
  if (durable != null) {
    if (typeof durable !== "object" || Array.isArray(durable)) return null;
    const evidence = durable as Record<string, unknown>;
    const requestIds = Array.isArray(evidence.providerRequestIds)
      ? evidence.providerRequestIds.filter((value): value is string => typeof value === "string") : [];
    const safeCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    const requestIdsValid = requestIds.every((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value));
    const v2Metered = evidence.contractVersion === 2 && authoritativeCostPair(evidence) &&
      safeCount(evidence.costMicrousd) &&
      adapterResult.budgetTelemetry?.costMicrousd === evidence.costMicrousd;
    const v3Metered = evidence.contractVersion === 3 &&
      evidence.billingMode === "metered_currency" &&
      evidence.billingAggregation === "single_mode" &&
      evidence.chargeApplicability === "charge_applicable" &&
      evidence.monetaryAmountMicrousd === evidence.costMicrousd &&
      evidence.monetaryCurrency === "USD" &&
      evidence.tokenAccountingBasis === "provider_reported_tokens_v1" &&
      authoritativeCostPair(evidence) && safeCount(evidence.costMicrousd) &&
      adapterResult.budgetTelemetry?.costMicrousd === evidence.costMicrousd;
    const v3Subscription = evidence.contractVersion === 3 &&
      authoritativeSubscriptionPair(evidence) &&
      adapterResult.budgetTelemetry?.costMicrousd === null;
    const runtimeAvailable = safeCount(evidence.providerRuntimeMs) &&
      evidence.runtimeBasis === "confirmed_provider_call_ms_v1";
    const runtimeUnavailable = v3Subscription &&
      evidence.providerRuntimeMs === null && evidence.runtimeBasis === null &&
      evidence.runtimeApplicability === "unavailable_by_route";
    if (evidence.status !== "complete" || evidence.complete !== true ||
        evidence.source !== "hermes_sqlite_transport_owner" ||
        (!v2Metered && !v3Metered && !v3Subscription) ||
        evidence.runId !== expectedRunId ||
        !Array.isArray(evidence.terminalDiscrepancies) || evidence.terminalDiscrepancies.length > 0 ||
        !safeCount(evidence.iterationAttempts) || !safeCount(evidence.providerDispatches) ||
        !safeCount(evidence.confirmedResponses) || !safeCount(evidence.pretransportDenials) ||
        evidence.unknownOutcomes !== 0 ||
        evidence.iterationAttempts !== (evidence.providerDispatches as number) +
          (evidence.pretransportDenials as number) ||
        evidence.providerDispatches !== evidence.confirmedResponses ||
        evidence.requestCount !== evidence.providerDispatches ||
        requestIds.length !== evidence.confirmedResponses || !requestIdsValid ||
        new Set(requestIds).size !== requestIds.length ||
        !safeCount(evidence.inputTokens) || !safeCount(evidence.outputTokens) ||
        (!runtimeAvailable && !runtimeUnavailable) ||
        typeof evidence.costAuthorityRef !== "string" || !evidence.costAuthorityRef.trim() ||
        adapterResult.budgetTelemetry?.requestCount !== evidence.requestCount ||
        adapterResult.budgetTelemetry?.providerRequestId !== requestIds[0] ||
        adapterResult.budgetTelemetry?.inputTokens !== evidence.inputTokens ||
        adapterResult.budgetTelemetry?.outputTokens !== evidence.outputTokens ||
        adapterResult.budgetTelemetry?.runtimeMs !== evidence.providerRuntimeMs ||
        adapterResult.usageBasis !== "per_run" || !rawUsage ||
        rawUsage.inputTokens !== evidence.inputTokens || rawUsage.outputTokens !== evidence.outputTokens) {
      return null;
    }
    return adapterResult.budgetTelemetry ?? null;
  }
  // Managed Hermes settlement requires versioned durable evidence. Legacy terminal counters,
  // nominal telemetry, and subscription labels are not authority.
  return null;
};

export function resolveManagedBudgetVerifier(
  override: ManagedBudgetVerifier | undefined,
  nodeEnv: string | undefined,
): ManagedBudgetVerifier {
  if (override && nodeEnv !== "test") {
    throw new Error("managed_budget_test_verifier_forbidden");
  }
  return override ?? verifyManagedBudgetEvidence;
}
