import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function absentOrZero(value: unknown): boolean { return value == null || value === 0; }

/** Pre-transport release authority is separate from provider billing evidence. */
export function verifyManagedPretransportEvidence(result: AdapterExecutionResult, runId: string): boolean {
  const recorded = object(result.resultJson);
  const evidence = object(recorded?.pretransportEvidence);
  if (!recorded || !evidence || !runId || evidence.runId !== runId ||
      evidence.version !== 1 || evidence.source !== "hermes_sqlite_transport_owner" ||
      evidence.complete !== true || evidence.boundary !== "never_crossed" ||
      evidence.terminalReason !== "managed_progress_policy_invalid") return false;
  if (![evidence.sessionId, evidence.attestationId].every((value) => typeof value === "string" && value.length > 0) ||
      typeof evidence.startedAt !== "number" || !Number.isFinite(evidence.startedAt) || evidence.startedAt <= 0 ||
      typeof evidence.sealedAt !== "number" || !Number.isFinite(evidence.sealedAt) || evidence.sealedAt < evidence.startedAt) return false;
  if ((result.errorCode != null && result.errorCode !== evidence.terminalReason) ||
      recorded.turn_exit_reason !== evidence.terminalReason || recorded.durableCallEvidence != null ||
      result.budgetTelemetry != null) return false;
  if (![result.costUsd, recorded.cost_usd, recorded.successfulProviderResponses,
      recorded.providerInputTokens].every(absentOrZero)) return false;
  if (recorded.providerRequestIds != null &&
      (!Array.isArray(recorded.providerRequestIds) || recorded.providerRequestIds.length !== 0)) return false;
  return [result.usage, recorded.usage].every((usage) => {
    if (usage == null) return true;
    const values = object(usage);
    return values !== null && Object.values(values).every(absentOrZero);
  });
}
