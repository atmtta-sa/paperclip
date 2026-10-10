import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";

export type ManagedBudgetVerifier = (
  adapterResult: AdapterExecutionResult,
  rawUsage: UsageSummary | null,
  expectedRunId: string,
) => NonNullable<AdapterExecutionResult["budgetTelemetry"]> | null;

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

export function managedHermesSettlementProvenance(
  adapterResult: AdapterExecutionResult,
  expectedRunId: string,
) {
  const durable = (adapterResult.resultJson ?? {}).durableCallEvidence;
  if (!durable || typeof durable !== "object" || Array.isArray(durable)) return null;
  const evidence = durable as Record<string, unknown>;
  if (evidence.source !== "hermes_sqlite_transport_owner" || evidence.contractVersion !== 2 ||
      evidence.runId !== expectedRunId || evidence.complete !== true ||
      typeof evidence.costBasis !== "string" || typeof evidence.runtimeBasis !== "string") return null;
  return {
    source: evidence.source,
    contractVersion: evidence.contractVersion,
    runId: expectedRunId,
    digestSha256: managedHermesEvidenceDigest(evidence),
    costBasis: evidence.costBasis,
    runtimeBasis: evidence.runtimeBasis,
  };
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
    if (evidence.status !== "complete" || evidence.complete !== true ||
        evidence.source !== "hermes_sqlite_transport_owner" || evidence.contractVersion !== 2 ||
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
        !safeCount(evidence.providerRuntimeMs) ||
        evidence.runtimeBasis !== "confirmed_provider_call_ms_v1" ||
        !safeCount(evidence.costMicrousd) ||
        !authoritativeCostPair(evidence) ||
        typeof evidence.costAuthorityRef !== "string" || !evidence.costAuthorityRef.trim() ||
        adapterResult.budgetTelemetry?.requestCount !== evidence.requestCount ||
        adapterResult.budgetTelemetry?.providerRequestId !== requestIds[0] ||
        adapterResult.budgetTelemetry?.inputTokens !== evidence.inputTokens ||
        adapterResult.budgetTelemetry?.outputTokens !== evidence.outputTokens ||
        adapterResult.budgetTelemetry?.runtimeMs !== evidence.providerRuntimeMs ||
        adapterResult.budgetTelemetry?.costMicrousd !== evidence.costMicrousd ||
        adapterResult.usageBasis !== "per_run" || !rawUsage ||
        rawUsage.inputTokens !== evidence.inputTokens || rawUsage.outputTokens !== evidence.outputTokens) {
      return null;
    }
    return adapterResult.budgetTelemetry ?? null;
  }
  // Managed Hermes settlement is contract-v2-only. Legacy terminal counters,
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
