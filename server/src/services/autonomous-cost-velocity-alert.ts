import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, autonomousBudgetReservations, budgetPolicies } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Policy = typeof budgetPolicies.$inferSelect;

/** In-app audit of committed cost velocity, not verified provider charges. */
export async function recordAutonomousCostVelocityAlert(
  tx: Transaction,
  input: { companyId: string; agentId: string; runId: string },
  policy: Policy,
  now: Date,
): Promise<void> {
  if (!policy.notifyEnabled || policy.scopeType !== "company"
    || policy.metric !== "billed_microusd" || policy.windowKind !== "calendar_day_utc"
    || policy.amount <= 0) return;
  const fifteenMinutesAgo = now.getTime() - 15 * 60_000;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(Math.max(fifteenMinutesAgo, dayStart));
  const rows = await tx.select({
    status: autonomousBudgetReservations.status,
    reserved: autonomousBudgetReservations.reservedCostMicrousd,
    actual: autonomousBudgetReservations.actualCostMicrousd,
  }).from(autonomousBudgetReservations)
    .where(and(eq(autonomousBudgetReservations.companyId, input.companyId),
      gte(autonomousBudgetReservations.createdAt, start),
      inArray(autonomousBudgetReservations.status, ["reserved", "reconciled", "retained_missing_telemetry"])));
  const committedCostMicrousd = rows.reduce((total, row) => total + (
    row.status === "reconciled" ? row.actual ?? row.reserved : row.reserved), 0);
  if (committedCostMicrousd * 4 < policy.amount) return;

  const [recent] = await tx.select({ id: activityLog.id }).from(activityLog)
    .where(and(eq(activityLog.companyId, input.companyId),
      eq(activityLog.action, "company.continuity_cost_velocity"),
      eq(activityLog.entityType, "company"),
      sql`${activityLog.details} ->> 'policyId' = ${policy.id}`,
      gte(activityLog.createdAt, start)))
    .limit(1);
  if (recent) return;
  await tx.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "autonomous-budget-reservation",
    action: "company.continuity_cost_velocity",
    entityType: "company",
    entityId: input.companyId,
    agentId: input.agentId,
    details: { policyId: policy.id, sourceRunId: input.runId,
      committedCostMicrousd, dailyLimitMicrousd: policy.amount, windowMinutes: 15 },
  });
}
