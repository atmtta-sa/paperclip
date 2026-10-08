import { and, eq } from "drizzle-orm";
import { autonomousBudgetReservations, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { verifyManagedPretransportEvidence } from "./managed-pretransport-evidence.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { parseExecutionCheckpoint } from "./execution-checkpoint.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Retry policy and accounting are independent; continuation supplies neither. */
export function predecessorRetryPolicyAllows(run: Pick<Run, "errorCode" | "resultJson">): boolean {
  const hint = run.resultJson?.retryHint;
  return !["non_retryable", "policy_blocked", "operator_action_required"].includes(String(hint)) &&
    !["no_progress", "managed_progress_policy_invalid", "adapter_result_inconsistent",
      "execution_input_budget_exceeded", "model_context_limit_exceeded", "context_budget_exceeded"]
      .includes(String(run.errorCode));
}

/** Positive retry authority; absence of a prohibition is not permission. */
export function predecessorRetryAuthorityAllows(
  run: Pick<Run, "errorCode" | "resultJson">,
): boolean {
  if (!predecessorRetryPolicyAllows(run)) return false;
  const result = object(run.resultJson);
  const errorCodeRollover = run.errorCode === "session_rollover_required";
  const resultRollover = result?.turn_exit_reason === "session_rollover_required";
  if (run.errorCode != null && result?.turn_exit_reason != null &&
      errorCodeRollover !== resultRollover) return false;
  if (errorCodeRollover || resultRollover) {
    const checkpoint = parseExecutionCheckpoint(result?.executionCheckpoint);
    return checkpoint?.blockers.status === "clear";
  }
  if (hasConversationContinuationPolicy(run.resultJson)) return true;
  const errorFamily = result?.errorFamily;
  return errorFamily === "transient_upstream" || errorFamily === "provider_quota";
}

type Reservation = typeof autonomousBudgetReservations.$inferSelect;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function attributedIssue(run: Run): string | null {
  const identities = [run.nativeIssueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId]
    .filter((value) => value != null);
  if (!identities.length || identities.some((value) => typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return null;
  return identities.every((value) => value === identities[0]) ? identities[0] as string : null;
}

function matchingProjection(run: Run, reservation: Reservation): boolean {
  const settlement = object(run.resultJson?.budgetSettlement);
  if (run.resultJson?.budgetSettlement != null && (!settlement ||
      (settlement.status != null && settlement.status !== reservation.status) ||
      (settlement.settlementState != null && settlement.settlementState !== reservation.settlementState))) return false;
  const durable = object(run.resultJson?.durableCallEvidence);
  if (run.resultJson?.durableCallEvidence != null && (!durable || durable.runId !== run.id ||
      durable.complete !== true || !Array.isArray(durable.terminalDiscrepancies) ||
      durable.terminalDiscrepancies.length > 0)) return false;
  return true;
}

function matchingUsage(run: Run, reservation: Reservation): boolean {
  if (run.usageJson == null) return true;
  const usage = object(run.usageJson);
  if (!usage) return false;
  const fields = { inputTokens: reservation.actualInputTokens, outputTokens: reservation.actualOutputTokens,
    requestCount: reservation.actualRequestCount, runtimeMs: reservation.actualRuntimeMs };
  return Object.entries(fields).every(([key, value]) => usage[key] == null || usage[key] === value);
}

function consumedSettlement(run: Run, reservation: Reservation): boolean {
  if (reservation.status !== "reconciled" || !reservation.providerActivityOccurred ||
      !reservation.providerRequestId?.trim() || run.resultJson?.pretransportEvidence != null ||
      !matchingUsage(run, reservation)) return false;
  const quantities = [reservation.actualRequestCount, reservation.actualInputTokens,
    reservation.actualOutputTokens, reservation.actualRuntimeMs, reservation.actualCostMicrousd];
  if (quantities.some((value) => value == null || !Number.isSafeInteger(value) || value < 0) ||
      reservation.actualRequestCount! < 1) return false;
  const reserved = [reservation.reservedRequestCount, reservation.reservedInputTokens,
    reservation.reservedOutputTokens, reservation.reservedRuntimeMs, reservation.reservedCostMicrousd];
  if (quantities.some((value, index) => value! > reserved[index]!)) return false;
  const expectedState = quantities.some((value, index) => value! < reserved[index]!)
    ? "partially_consumed" : "consumed";
  return reservation.settlementState === expectedState;
}

function zeroSettlement(run: Run, reservation: Reservation): boolean {
  if (reservation.status !== "released" || reservation.settlementState !== "released_zero_usage" ||
      reservation.providerActivityOccurred || reservation.providerRequestId != null) return false;
  const actuals = [reservation.actualRequestCount, reservation.actualInputTokens, reservation.actualOutputTokens,
    reservation.actualRuntimeMs, reservation.actualCostCents, reservation.actualCostMicrousd];
  if (actuals.some((value) => value != null)) return false;
  if (run.usageJson != null) {
    const usage = object(run.usageJson);
    if (!usage || Object.values(usage).some((value) => value != null && value !== 0)) return false;
  }
  return verifyManagedPretransportEvidence({ exitCode: run.exitCode, signal: run.signal, timedOut: false,
    errorCode: run.errorCode, resultJson: run.resultJson }, run.id);
}

/** Accounting only. Call under company -> issue locks; permission remains a separate gate. */
export async function lockEligibleAutomaticSuccessorSettlement(db: Db, run: Run): Promise<boolean> {
  const [current] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId),
  )).for("update");
  if (!current || !["succeeded", "failed", "timed_out", "interrupted", "cancelled"].includes(current.status) ||
      current.finishedAt === null) return false;
  const issueId = attributedIssue(current);
  // Independent work must be positively authorized by its own admission owner.
  if (!issueId) return false;
  const [reservation] = await db.select().from(autonomousBudgetReservations).where(and(
    eq(autonomousBudgetReservations.runId, current.id),
    eq(autonomousBudgetReservations.companyId, current.companyId),
    eq(autonomousBudgetReservations.agentId, current.agentId),
    eq(autonomousBudgetReservations.issueId, issueId),
  )).for("update");
  if (!reservation || reservation.reconciledAt === null || !matchingProjection(current, reservation)) return false;
  return consumedSettlement(current, reservation) || zeroSettlement(current, reservation);
}

/**
 * Revalidate automatic-successor settlement under the budget admission locks.
 * Null means the supplied run is not a persisted automatic successor.
 */
export async function lockEligibleAutomaticSuccessorLaunchSettlement(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousRunId: string;
  },
): Promise<boolean | null> {
  const hint = await db.select({ retryOfRunId: heartbeatRuns.retryOfRunId })
    .from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    )).then((rows) => rows[0] ?? null);
  if (!hint) return null;

  const [issue] = await db.select({
    assigneeAgentId: issues.assigneeAgentId,
    executionRunId: issues.executionRunId,
    status: issues.status,
  }).from(issues).where(and(
    eq(issues.id, input.issueId),
    eq(issues.companyId, input.companyId),
  )).for("update");
  if (!issue || issue.assigneeAgentId !== input.agentId ||
      issue.executionRunId !== input.runId || ["done", "cancelled"].includes(issue.status)) return false;

  const [successor] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  )).for("update");
  if (!successor || successor.status !== "running" ||
      successor.retryOfRunId !== input.previousRunId ||
      attributedIssue(successor) !== input.issueId) return false;

  const predecessor = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.previousRunId),
    eq(heartbeatRuns.companyId, input.companyId),
  )).for("update").then((rows) => rows[0] ?? null);
  if (!predecessor || !predecessorRetryAuthorityAllows(predecessor)) return false;
  return lockEligibleAutomaticSuccessorSettlement(db, predecessor);
}
