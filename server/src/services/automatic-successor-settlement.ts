import { and, eq } from "drizzle-orm";
import { autonomousBudgetReservations, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { verifyManagedPretransportEvidence } from "./managed-pretransport-evidence.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { managedHermesEvidenceDigest } from "./managed-budget-evidence.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Retry policy and accounting are independent; continuation supplies neither. */
export function predecessorRetryPolicyAllows(run: Pick<Run, "errorCode" | "resultJson">): boolean {
  const hint = run.resultJson?.retryHint;
  const terminal = object(run.resultJson);
  const requestBudgetExhausted = [run.errorCode, terminal?.turn_exit_reason, terminal?.stop_reason]
    .some((value) => value === "run_request_budget_exhausted");
  return !["non_retryable", "policy_blocked", "operator_action_required"].includes(String(hint)) &&
    !requestBudgetExhausted &&
    !["no_progress", "managed_progress_policy_invalid", "adapter_result_inconsistent",
      "execution_input_budget_exceeded", "model_context_limit_exceeded", "context_budget_exceeded",
      "run_request_budget_exhausted"]
      .includes(String(run.errorCode));
}

/** Positive retry authority; absence of a prohibition is not permission. */
export function predecessorRetryAuthorityAllows(
  run: Pick<Run, "errorCode" | "resultJson">,
): boolean {
  if (!predecessorRetryPolicyAllows(run)) return false;
  if (hasConversationContinuationPolicy(run.resultJson)) return true;
  const errorFamily = object(run.resultJson)?.errorFamily;
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

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function authoritativeCostPair(durable: Record<string, unknown>): boolean {
  return durable.costBasis === "provider_actual" &&
    durable.costAuthority === "provider_usage_response";
}

function authoritativeSettlementPair(durable: Record<string, unknown>): boolean {
  if (durable.providerDispatches === 0) {
    return durable.costBasis === "pretransport_zero" &&
      durable.costAuthority === "transport_owner_never_crossed" &&
      durable.costAuthorityRef === `exact-run-denial:${String(durable.runId)}`;
  }
  return authoritativeCostPair(durable);
}

export async function managedHermesSuccessorBinding(db: Db, run: Run) {
  const reservation = await db.select({
    provider: autonomousBudgetReservations.provider,
    settlementEvidence: autonomousBudgetReservations.settlementEvidence,
  }).from(autonomousBudgetReservations).where(and(
    eq(autonomousBudgetReservations.runId, run.id),
    eq(autonomousBudgetReservations.companyId, run.companyId),
    eq(autonomousBudgetReservations.agentId, run.agentId),
  )).then((rows) => rows[0] ?? null);
  if (!reservation || reservation.provider !== "hermes_local") return null;
  const evidence = object(reservation.settlementEvidence);
  if (!evidence || evidence.source !== "hermes_sqlite_transport_owner" ||
      evidence.contractVersion !== 2 || evidence.runId !== run.id ||
      typeof evidence.digestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(evidence.digestSha256)) return null;
  return evidence;
}

async function matchingSuccessorBinding(db: Db, successor: Run, predecessor: Run): Promise<boolean> {
  const expected = await managedHermesSuccessorBinding(db, predecessor);
  const recorded = object(successor.contextSnapshot?.managedHermesPredecessorSettlement);
  if (expected === null) return recorded === null;
  if (recorded === null) return false;
  const expectedEntries = Object.entries(expected);
  return Object.keys(recorded).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => recorded[key] === value);
}

function matchingDurableEvidence(
  durable: Record<string, unknown>, run: Run, reservation: Reservation,
): boolean {
  const provenance = object(reservation.settlementEvidence);
  const requestIds = Array.isArray(durable.providerRequestIds) &&
    durable.providerRequestIds.every((value) => typeof value === "string" &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(value))
    ? durable.providerRequestIds as string[] : null;
  const counts = [durable.iterationAttempts, durable.providerDispatches,
    durable.confirmedResponses, durable.pretransportDenials, durable.unknownOutcomes,
    durable.requestCount, durable.inputTokens, durable.outputTokens];
  if (durable.status !== "complete" || durable.source !== "hermes_sqlite_transport_owner" ||
      durable.contractVersion !== 2 || durable.runId !== run.id || durable.complete !== true ||
      !Array.isArray(durable.terminalDiscrepancies) || durable.terminalDiscrepancies.length > 0 ||
      counts.some((value) => !safeCount(value)) || durable.unknownOutcomes !== 0 || !requestIds ||
      durable.iterationAttempts !== (durable.providerDispatches as number) +
        (durable.pretransportDenials as number) ||
      durable.providerDispatches !== durable.confirmedResponses ||
      durable.requestCount !== durable.providerDispatches ||
      requestIds.length !== durable.confirmedResponses || new Set(requestIds).size !== requestIds.length ||
      !safeCount(durable.providerRuntimeMs) ||
      durable.runtimeBasis !== "confirmed_provider_call_ms_v1" ||
      !safeCount(durable.costMicrousd) ||
      !authoritativeSettlementPair(durable) ||
      typeof durable.costAuthorityRef !== "string" || !durable.costAuthorityRef.trim() ||
      !provenance || provenance.source !== durable.source ||
      provenance.contractVersion !== durable.contractVersion || provenance.runId !== durable.runId ||
      provenance.costBasis !== durable.costBasis || provenance.runtimeBasis !== durable.runtimeBasis ||
      provenance.digestSha256 !== managedHermesEvidenceDigest(durable)) return false;
  const costMicrousd = durable.costMicrousd as number;
  if (durable.providerDispatches === 0) {
    return reservation.status === "released" && reservation.providerRequestId == null &&
      durable.pretransportDenials === durable.iterationAttempts && durable.inputTokens === 0 &&
      durable.outputTokens === 0 && durable.providerRuntimeMs === 0 && costMicrousd === 0;
  }
  return reservation.status === "reconciled" &&
    durable.providerDispatches === reservation.actualRequestCount &&
    durable.inputTokens === reservation.actualInputTokens &&
    durable.outputTokens === reservation.actualOutputTokens &&
    durable.providerRuntimeMs === reservation.actualRuntimeMs &&
    costMicrousd === reservation.actualCostMicrousd && requestIds[0] === reservation.providerRequestId;
}

function matchingProjection(run: Run, reservation: Reservation): boolean {
  const settlement = object(run.resultJson?.budgetSettlement);
  if (run.resultJson?.budgetSettlement != null && (!settlement ||
      (settlement.status != null && settlement.status !== reservation.status) ||
      (settlement.settlementState != null && settlement.settlementState !== reservation.settlementState))) return false;
  const durable = object(run.resultJson?.durableCallEvidence);
  if (reservation.provider === "hermes_local" &&
      (!durable || !matchingDurableEvidence(durable, run, reservation))) return false;
  return true;
}

function matchingUsage(run: Run, reservation: Reservation): boolean {
  const managedHermes = reservation.provider === "hermes_local";
  if (run.usageJson == null) return !managedHermes;
  const usage = object(run.usageJson);
  if (!usage) return false;
  const fields = { inputTokens: reservation.actualInputTokens, outputTokens: reservation.actualOutputTokens,
    requestCount: reservation.actualRequestCount, runtimeMs: reservation.actualRuntimeMs };
  return Object.entries(fields).every(([key, value]) =>
    managedHermes ? usage[key] === value : usage[key] == null || usage[key] === value,
  );
}

function consumedSettlement(run: Run, reservation: Reservation): boolean {
  if (reservation.status !== "reconciled" || !reservation.providerActivityOccurred ||
      !reservation.providerRequestId?.trim() || run.resultJson?.pretransportEvidence != null ||
      (reservation.provider === "hermes_local" && run.resultJson?.durableCallEvidence == null) ||
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
  if (!predecessor || !predecessorRetryAuthorityAllows(predecessor) ||
      !await matchingSuccessorBinding(db, successor, predecessor)) return false;
  return lockEligibleAutomaticSuccessorSettlement(db, predecessor);
}
