import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, autonomousBudgetReservations, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { autonomousPolicyLimits } from "./autonomous-policy-limits.js";

/** Read-only operator view. Totals are all-time ledger commitments, not provider billing. */
export async function autonomousContinuitySnapshot(db: Db, companyId: string) {
  const [company] = await db.select({ status: companies.status, autonomousPaused: companies.autonomousExecutionPaused })
    .from(companies).where(eq(companies.id, companyId));
  if (!company) return null;

  const [totals] = await db.select({
    runs: sql<number>`count(*)::integer`,
    requests: sql<number>`coalesce(sum(case when ${autonomousBudgetReservations.status} = 'reconciled' then coalesce(${autonomousBudgetReservations.actualRequestCount}, ${autonomousBudgetReservations.reservedRequestCount}) else ${autonomousBudgetReservations.reservedRequestCount} end), 0)::double precision`,
    inputTokens: sql<number>`coalesce(sum(case when ${autonomousBudgetReservations.status} = 'reconciled' then coalesce(${autonomousBudgetReservations.actualInputTokens}, ${autonomousBudgetReservations.reservedInputTokens}) else ${autonomousBudgetReservations.reservedInputTokens} end), 0)::double precision`,
    outputTokens: sql<number>`coalesce(sum(case when ${autonomousBudgetReservations.status} = 'reconciled' then coalesce(${autonomousBudgetReservations.actualOutputTokens}, ${autonomousBudgetReservations.reservedOutputTokens}) else ${autonomousBudgetReservations.reservedOutputTokens} end), 0)::double precision`,
    costMicrousd: sql<number>`coalesce(sum(case when ${autonomousBudgetReservations.status} = 'reconciled' then coalesce(${autonomousBudgetReservations.actualCostMicrousd}, ${autonomousBudgetReservations.reservedCostMicrousd}) else ${autonomousBudgetReservations.reservedCostMicrousd} end), 0)::double precision`,
    held: sql<number>`count(*) filter (where ${autonomousBudgetReservations.status} in ('reserved', 'retained_missing_telemetry'))::integer`,
    missingTelemetry: sql<number>`count(*) filter (where ${autonomousBudgetReservations.status} = 'retained_missing_telemetry')::integer`,
  }).from(autonomousBudgetReservations)
    .where(and(
      eq(autonomousBudgetReservations.companyId, companyId),
      ne(autonomousBudgetReservations.status, "released"),
    ));

  const recent = await db.select({
    runId: autonomousBudgetReservations.runId,
    agentId: autonomousBudgetReservations.agentId,
    issueId: autonomousBudgetReservations.issueId,
    agentAutonomousPaused: agents.autonomousExecutionPaused,
    taskAutonomousPaused: issues.autonomousExecutionPaused,
    reservationStatus: autonomousBudgetReservations.status,
    reservedCostMicrousd: autonomousBudgetReservations.reservedCostMicrousd,
    actualCostMicrousd: autonomousBudgetReservations.actualCostMicrousd,
    workOutcome: heartbeatRuns.workOutcome,
    fingerprintBefore: heartbeatRuns.stateFingerprintBefore,
    fingerprintAfter: heartbeatRuns.stateFingerprintAfter,
    noProgressStreak: heartbeatRuns.noProgressStreak,
    circuitState: heartbeatRuns.continuityCircuitState,
    stopReason: heartbeatRuns.errorCode,
    createdAt: autonomousBudgetReservations.createdAt,
  }).from(autonomousBudgetReservations)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, autonomousBudgetReservations.runId))
    .leftJoin(agents, and(eq(agents.id, autonomousBudgetReservations.agentId), eq(agents.companyId, companyId)))
    .leftJoin(issues, and(eq(issues.id, autonomousBudgetReservations.issueId), eq(issues.companyId, companyId)))
    .where(eq(autonomousBudgetReservations.companyId, companyId))
    .orderBy(desc(autonomousBudgetReservations.createdAt), desc(autonomousBudgetReservations.id))
    .limit(25);

  const alertRows = await db.select({
    id: activityLog.id,
    issueId: activityLog.entityId,
    agentId: activityLog.agentId,
    runId: activityLog.runId,
    details: activityLog.details,
    createdAt: activityLog.createdAt,
  }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.continuity_circuit_opened"),
      eq(activityLog.entityType, "issue")))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(25);
  const circuitAlerts = alertRows.map(({ details, ...row }) => ({
    ...row,
    stateFingerprint: typeof details?.stateFingerprint === "string" ? details.stateFingerprint : null,
    circuitOpenedAt: typeof details?.circuitOpenedAt === "string" ? details.circuitOpenedAt : null,
  }));

  const growthRows = await db.select({
    id: activityLog.id,
    issueId: activityLog.entityId,
    agentId: activityLog.agentId,
    runId: activityLog.runId,
    details: activityLog.details,
    createdAt: activityLog.createdAt,
  }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.continuity_prompt_growth"),
      eq(activityLog.entityType, "issue")))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(25);
  const promptGrowthAlerts = growthRows.flatMap(({ details, ...row }) => {
    const previousInputTokens = details?.previousInputTokens;
    const actualInputTokens = details?.actualInputTokens;
    return typeof previousInputTokens === "number" && Number.isSafeInteger(previousInputTokens)
      && typeof actualInputTokens === "number" && Number.isSafeInteger(actualInputTokens)
      ? [{ ...row, runId: row.runId ?? (typeof details?.sourceRunId === "string" ? details.sourceRunId : null),
        previousInputTokens, actualInputTokens }] : [];
  });

  const velocityRows = await db.select({
    id: activityLog.id,
    companyId: activityLog.entityId,
    agentId: activityLog.agentId,
    details: activityLog.details,
    createdAt: activityLog.createdAt,
  }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.action, "company.continuity_cost_velocity"),
      eq(activityLog.entityType, "company"), eq(activityLog.entityId, companyId)))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(25);
  const costVelocityAlerts = velocityRows.flatMap(({ details, ...row }) => {
    const cost = details?.committedCostMicrousd;
    const limit = details?.dailyLimitMicrousd;
    const minutes = details?.windowMinutes;
    return typeof cost === "number" && Number.isSafeInteger(cost) && cost >= 0
      && typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
      && minutes === 15
      ? [{ ...row, runId: typeof details?.sourceRunId === "string" ? details.sourceRunId : null,
        committedCostMicrousd: cost, dailyLimitMicrousd: limit, windowMinutes: minutes }] : [];
  });

  const policyLimits = await autonomousPolicyLimits(db, companyId);
  return { companyId, paused: company.status === "paused" || company.autonomousPaused,
    autonomousPaused: company.autonomousPaused, totals, recent, circuitAlerts, promptGrowthAlerts,
    costVelocityAlerts, policyLimits };
}
