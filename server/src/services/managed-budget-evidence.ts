import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";

export type ManagedBudgetVerifier = (
  adapterResult: AdapterExecutionResult,
  rawUsage: UsageSummary | null,
) => NonNullable<AdapterExecutionResult["budgetTelemetry"]> | null;

/** Production acceptance rules; token completeness is not billing authority. */
export const verifyManagedBudgetEvidence: ManagedBudgetVerifier = (adapterResult, rawUsage) => {
  // An explicit incomplete Hermes result cannot be repaired by a nominal
  // adapter telemetry object; keep the reservation until reconciliation.
  const resultEvidence = (adapterResult.resultJson ?? {});
  const durable = resultEvidence.durableCallEvidence;
  if (durable != null) {
    if (typeof durable !== "object" || Array.isArray(durable)) return null;
    const evidence = durable as Record<string, unknown>;
    if (evidence.complete !== true || !Array.isArray(evidence.terminalDiscrepancies) ||
        evidence.terminalDiscrepancies.length > 0) return null;
  }
  const codexSubscriptionEvidence =
    resultEvidence.provider === "openai-codex" &&
    resultEvidence.billingType === "subscription" &&
    resultEvidence.budgetTelemetryComplete === true &&
    resultEvidence.costStatus === "included" &&
    resultEvidence.costUnavailableReason == null &&
    resultEvidence.cost_usd === 0;
  const hasHermesUsageEvidence =
    typeof resultEvidence.usageTelemetryComplete === "boolean";
  const budgetEvidenceComplete = !hasHermesUsageEvidence ||
    resultEvidence.budgetTelemetryComplete === true ||
    (resultEvidence.budgetTelemetryComplete == null &&
      resultEvidence.usageTelemetryComplete === true);
  const hermesCostNotVerified =
    (typeof resultEvidence.usageTelemetryComplete === "boolean" &&
      resultEvidence.costStatus !== "actual" && !codexSubscriptionEvidence) ||
    (typeof resultEvidence.costUnavailableReason === "string" &&
      resultEvidence.costUnavailableReason.length > 0);
  const providerRequestIds = Array.isArray(resultEvidence.providerRequestIds)
    ? resultEvidence.providerRequestIds
    : [];
  const requestCountValid = codexSubscriptionEvidence
    ? Number.isSafeInteger(resultEvidence.apiCalls) &&
      Number.isSafeInteger(resultEvidence.successfulProviderResponses) &&
      (resultEvidence.successfulProviderResponses as number) >= 1 &&
      (resultEvidence.apiCalls as number) >=
        (resultEvidence.successfulProviderResponses as number) &&
      providerRequestIds.length === resultEvidence.successfulProviderResponses &&
      adapterResult.budgetTelemetry?.requestCount === resultEvidence.apiCalls
    : resultEvidence.apiCalls === 1 && providerRequestIds.length === 1 &&
      adapterResult.budgetTelemetry?.requestCount === 1;
  const hermesRequestMismatch = typeof resultEvidence.costStatus === "string" &&
    (!requestCountValid ||
      providerRequestIds[0] !== adapterResult.budgetTelemetry?.providerRequestId);
  const hermesCostMismatch = (resultEvidence.costStatus === "actual" ||
    codexSubscriptionEvidence) &&
    (typeof resultEvidence.cost_usd !== "number" ||
      !Number.isFinite(resultEvidence.cost_usd) ||
      resultEvidence.cost_usd < 0 ||
      !Number.isSafeInteger(Math.round(resultEvidence.cost_usd * 1_000_000)) ||
      Math.round(resultEvidence.cost_usd * 1_000_000) !==
        adapterResult.budgetTelemetry?.costMicrousd);
  const hermesUsageMismatch = typeof resultEvidence.usageTelemetryComplete === "boolean" &&
    (adapterResult.usageBasis !== "per_run" || !rawUsage ||
      rawUsage.inputTokens !== adapterResult.budgetTelemetry?.inputTokens ||
      rawUsage.outputTokens !== adapterResult.budgetTelemetry?.outputTokens);
  // Hermes token completeness does not prove its charge or request identity.
  // Subscription-backed Codex has no metered cost, but still requires a
  // provider response ID and exact per-run token evidence.
  const budgetTelemetry = !budgetEvidenceComplete || hermesCostNotVerified ||
    hermesRequestMismatch || hermesCostMismatch || hermesUsageMismatch
    ? null
    : adapterResult.budgetTelemetry ?? null;
  return budgetTelemetry;
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
