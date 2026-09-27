import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { autonomousBudgetReservations, budgetPolicies } from "@paperclipai/db";

type Reservation = typeof autonomousBudgetReservations.$inferSelect;
type Policy = typeof budgetPolicies.$inferSelect;

function committedMetric(row: Reservation, metric: Policy["metric"]): number {
  const reconciled = row.status === "reconciled";
  const cost = reconciled
    ? row.actualCostMicrousd ?? row.reservedCostMicrousd ?? row.reservedCostCents * 10_000
    : row.reservedCostMicrousd ?? row.reservedCostCents * 10_000;
  switch (metric) {
    case "billed_cents": return cost / 10_000;
    case "billed_microusd": return cost;
    case "request_count": return reconciled ? row.actualRequestCount ?? row.reservedRequestCount : row.reservedRequestCount;
    case "input_tokens": return reconciled ? row.actualInputTokens ?? row.reservedInputTokens : row.reservedInputTokens;
    case "output_tokens": return reconciled ? row.actualOutputTokens ?? row.reservedOutputTokens : row.reservedOutputTokens;
    case "runtime_ms": return reconciled ? row.actualRuntimeMs ?? row.reservedRuntimeMs : row.reservedRuntimeMs;
  }
}

/** Read-only admission-policy ledger commitments; not provider-billed spend. */
export async function autonomousPolicyLimits(db: Db, companyId: string, now = new Date()) {
  const policies = await db.select().from(budgetPolicies)
    .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.isActive, true),
      eq(budgetPolicies.hardStopEnabled, true),
      inArray(budgetPolicies.scopeType, ["company", "agent", "task"])))
    .orderBy(budgetPolicies.scopeType, budgetPolicies.scopeId, budgetPolicies.metric);
  return Promise.all(policies.map(async (policy) => {
    const { id, scopeType, scopeId, metric, windowKind, amount } = policy;
    if (windowKind === "per_run") {
      return { id, scopeType, scopeId, metric, windowKind, amount,
        committed: null, remaining: null };
    }
    const start = windowKind === "lifetime" ? null : windowKind === "calendar_day_utc"
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const scope = scopeType === "company" ? eq(autonomousBudgetReservations.companyId, companyId)
      : scopeType === "agent" ? and(eq(autonomousBudgetReservations.companyId, companyId),
        eq(autonomousBudgetReservations.agentId, scopeId))
      : and(eq(autonomousBudgetReservations.companyId, companyId),
        eq(autonomousBudgetReservations.issueId, scopeId));
    const rows = await db.select().from(autonomousBudgetReservations)
      .where(and(scope, start ? gte(autonomousBudgetReservations.createdAt, start) : undefined,
        inArray(autonomousBudgetReservations.status, ["reserved", "reconciled", "retained_missing_telemetry"])));
    const committed = rows.reduce((total, row) => total + committedMetric(row, metric), 0);
    return { id, scopeType, scopeId, metric, windowKind, amount, committed,
      remaining: Math.max(0, amount - committed) };
  }));
}
