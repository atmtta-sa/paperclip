import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
/** Pre-transport release authority is separate from provider billing evidence. */
export function verifyManagedPretransportEvidence(result: AdapterExecutionResult, runId: string): boolean {
  const recorded = object(result.resultJson);
  const durable = object(recorded?.durableCallEvidence);
  if (recorded && durable && runId && durable.runId === runId && durable.status === "complete" &&
      durable.source === "hermes_sqlite_transport_owner" && durable.contractVersion === 2 &&
      durable.complete === true && Number.isSafeInteger(durable.iterationAttempts) &&
      (durable.iterationAttempts as number) > 0 &&
      durable.pretransportDenials === durable.iterationAttempts && durable.providerDispatches === 0 &&
      durable.confirmedResponses === 0 && durable.unknownOutcomes === 0 && durable.requestCount === 0 &&
      durable.inputTokens === 0 && durable.outputTokens === 0 && durable.estimatedCostUsd === 0 &&
      durable.providerRuntimeMs === 0 && durable.runtimeBasis === "confirmed_provider_call_ms_v1" &&
      durable.costMicrousd === 0 && durable.costBasis === "pretransport_zero" &&
      durable.costAuthority === "transport_owner_never_crossed" &&
      durable.costAuthorityRef === `exact-run-denial:${runId}` &&
      Array.isArray(durable.providerRequestIds) && durable.providerRequestIds.length === 0 &&
      Array.isArray(durable.terminalDiscrepancies) && durable.terminalDiscrepancies.length === 0 &&
      result.budgetTelemetry == null && result.usage == null && result.costUsd == null) return true;
  return false;
}
