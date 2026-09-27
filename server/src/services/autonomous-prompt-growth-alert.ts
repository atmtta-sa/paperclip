import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, autonomousBudgetReservations, heartbeatRuns } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reservation = typeof autonomousBudgetReservations.$inferSelect;

/** Caller holds the company lock; audit only, never wakes or mutates a task. */
export async function recordAutonomousPromptGrowthAlert(
  tx: Transaction,
  row: Reservation,
  actual: { requestCount: number; inputTokens: number },
): Promise<void> {
  if (actual.requestCount !== 1 || !row.provider || !row.model || !row.issueId) return;
  const [previous] = await tx.select({ inputTokens: autonomousBudgetReservations.actualInputTokens })
    .from(autonomousBudgetReservations)
    .where(and(
      eq(autonomousBudgetReservations.companyId, row.companyId),
      eq(autonomousBudgetReservations.agentId, row.agentId),
      eq(autonomousBudgetReservations.issueId, row.issueId),
      eq(autonomousBudgetReservations.provider, row.provider),
      eq(autonomousBudgetReservations.model, row.model),
      ne(autonomousBudgetReservations.id, row.id),
      eq(autonomousBudgetReservations.status, "reconciled"),
      eq(autonomousBudgetReservations.actualRequestCount, 1),
    ))
    .orderBy(desc(autonomousBudgetReservations.reconciledAt), desc(autonomousBudgetReservations.id))
    .limit(1);
  if (previous?.inputTokens == null || previous.inputTokens <= 0
    || actual.inputTokens - previous.inputTokens < 20_000
    || previous.inputTokens > actual.inputTokens / 2) return;

  const [recentAlert] = await tx.select({ id: activityLog.id }).from(activityLog)
    .where(and(
      eq(activityLog.companyId, row.companyId),
      eq(activityLog.agentId, row.agentId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, row.issueId),
      eq(activityLog.action, "issue.continuity_prompt_growth"),
      sql`${activityLog.details} ->> 'provider' = ${row.provider}`,
      sql`${activityLog.details} ->> 'model' = ${row.model}`,
      gte(activityLog.createdAt, new Date(Date.now() - 15 * 60_000)),
    )).limit(1);
  if (recentAlert) return;

  const [linkedRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, row.runId), eq(heartbeatRuns.companyId, row.companyId)))
    .limit(1);
  await tx.insert(activityLog).values({
    companyId: row.companyId,
    actorType: "system",
    actorId: "autonomous-budget-reconciliation",
    action: "issue.continuity_prompt_growth",
    entityType: "issue",
    entityId: row.issueId,
    agentId: row.agentId,
    runId: linkedRun?.id ?? null,
    details: { sourceRunId: row.runId,
      previousInputTokens: previous.inputTokens, actualInputTokens: actual.inputTokens,
      provider: row.provider, model: row.model },
  });
}
