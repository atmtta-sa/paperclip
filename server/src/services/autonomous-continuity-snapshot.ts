import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, autonomousBudgetReservations, companies, heartbeatRuns } from "@paperclipai/db";

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

  return { companyId, paused: company.status === "paused" || company.autonomousPaused,
    autonomousPaused: company.autonomousPaused, totals, recent, circuitAlerts };
}
