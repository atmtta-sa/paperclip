import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies, heartbeatRuns } from "@paperclipai/db";

type CircuitRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "continuityCircuitState" |
  "continuityCircuitOpenedAt" | "continuityCircuitAlertedAt" | "stateFingerprintAfter" | "noProgressStreak">;

/** Record one operator audit alert per company/agent/task/fingerprint/circuit episode. */
export async function recordContinuityCircuitAlert(db: Db, run: CircuitRun, issueId: string): Promise<void> {
  if (run.continuityCircuitState !== "open" || !run.continuityCircuitOpenedAt ||
      run.continuityCircuitAlertedAt) return;
  const openedAt = run.continuityCircuitOpenedAt.toISOString();
  await db.transaction(async (tx) => {
    // Serialize competing runs as well as repeat delivery attempts, without waking an agent.
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, run.companyId)).for("update");
    if (!company) return;
    const alertedAt = new Date();
    const [claimed] = await tx.update(heartbeatRuns)
      .set({ continuityCircuitAlertedAt: alertedAt, updatedAt: alertedAt })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.continuityCircuitState, "open"),
        isNull(heartbeatRuns.continuityCircuitAlertedAt)))
      .returning({ id: heartbeatRuns.id });
    if (!claimed) return;
    const [existing] = await tx.select({ id: activityLog.id }).from(activityLog)
      .where(and(eq(activityLog.companyId, run.companyId),
        eq(activityLog.agentId, run.agentId), eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.continuity_circuit_opened"),
        sql`${activityLog.details} ->> 'circuitOpenedAt' = ${openedAt}`,
        sql`coalesce(${activityLog.details} ->> 'stateFingerprint', '') = ${run.stateFingerprintAfter ?? ""}`))
      .limit(1);
    if (existing) return;
    await tx.insert(activityLog).values({
      companyId: run.companyId,
      actorType: "system",
      actorId: "continuity-circuit-breaker",
      action: "issue.continuity_circuit_opened",
      entityType: "issue",
      entityId: issueId,
      agentId: run.agentId,
      runId: run.id,
      responsibleUserId: run.responsibleUserId,
      details: { stateFingerprint: run.stateFingerprintAfter,
        noProgressStreak: run.noProgressStreak, circuitOpenedAt: openedAt },
      createdAt: alertedAt,
    });
  });
}
