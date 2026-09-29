export const LOGICAL_EXECUTION_PROVIDER_ATTEMPT_LIMIT = 2;

export type LogicalExecutionIdentity = {
  key: string;
  rootRunId: string;
  providerAttempt: number;
};

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
  return {
    key: `issue:${issueId ?? "no-issue"}:generation:${run.id}`,
    rootRunId: run.id,
    providerAttempt: providerWorkStarted === false ? 1 : 2,
  };
}
