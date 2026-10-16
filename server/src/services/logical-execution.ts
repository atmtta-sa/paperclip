export const LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT = 3;
export const TRANSIENT_PROVIDER_FAILURE_ATTEMPT_LIMIT = 2;

export type AutomaticSuccessorAdmissionReason =
  | "logical_execution_provider_attempt_limit_exhausted"
  | "logical_execution_root_chain_request_budget_exhausted";

/** Root-chain capacity wins when both bounded generation controls are exhausted. */
export function evaluateAutomaticSuccessorAdmission(input: {
  nextProviderAttempt: number;
  committedRootChainRequests: number;
  requestedRequestCount: number;
  maxRootChainProviderRequests: number | null;
}): { eligible: true } | { eligible: false; reason: AutomaticSuccessorAdmissionReason } {
  if (
    input.maxRootChainProviderRequests !== null &&
    input.committedRootChainRequests + input.requestedRequestCount >
      input.maxRootChainProviderRequests
  ) {
    return {
      eligible: false,
      reason: "logical_execution_root_chain_request_budget_exhausted",
    };
  }
  if (input.nextProviderAttempt > LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT) {
    return {
      eligible: false,
      reason: "logical_execution_provider_attempt_limit_exhausted",
    };
  }
  return { eligible: true };
}

export type LogicalExecutionIdentity = {
  key: string;
  rootRunId: string;
  providerAttempt: number;
};

export function startLogicalExecutionIdentity(
  runId: string,
  issueId: string | null,
): LogicalExecutionIdentity {
  return {
    key: `issue:${issueId ?? "no-issue"}:generation:${runId}`,
    rootRunId: runId,
    providerAttempt: 1,
  };
}

type RetrySourceRun = {
  id: string;
  retryOfRunId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  resultJson?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/** Derive the stable identity and provider ordinal for one automatic successor. */
export function nextLogicalExecutionIdentity(
  run: RetrySourceRun,
  issueId: string | null,
): LogicalExecutionIdentity {
  const predecessorRunId = nonEmptyString(run.retryOfRunId);
  const prior = record(record(run.contextSnapshot).logicalExecution);
  const priorRootRunId = nonEmptyString(prior.rootRunId);
  const priorKey = nonEmptyString(prior.key);
  const priorAttempt = positiveInteger(prior.providerAttempt);

  if (predecessorRunId) {
    const expectedKey = priorRootRunId
      ? `issue:${issueId ?? "no-issue"}:generation:${priorRootRunId}`
      : null;
    if (
      !priorRootRunId ||
      !priorKey ||
      priorKey !== expectedKey ||
      !priorAttempt
    ) {
      return {
        key: `issue:${issueId ?? "no-issue"}:generation:${predecessorRunId}`,
        rootRunId: predecessorRunId,
        providerAttempt: LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT + 1,
      };
    }

    const providerWorkStarted =
      record(record(run.resultJson).executionRecovery).providerWorkStarted;
    return {
      key: priorKey,
      rootRunId: priorRootRunId,
      providerAttempt:
        providerWorkStarted === false ? priorAttempt : priorAttempt + 1,
    };
  }

  const providerWorkStarted =
    record(record(run.resultJson).executionRecovery).providerWorkStarted;
  const identity = startLogicalExecutionIdentity(run.id, issueId);
  return providerWorkStarted === false
    ? identity
    : { ...identity, providerAttempt: 2 };
}
