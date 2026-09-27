import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, issues } from "@paperclipai/db";

/** Board-only caller supplies actor identity; this mutation never wakes an agent. */
export async function setAutonomousExecutionPause(
  db: Db,
  input: { companyId: string; paused: boolean; actorId: string },
): Promise<{ companyId: string; paused: boolean } | null> {
  return db.transaction(async (tx) => {
    const [company] = await tx.select({ paused: companies.autonomousExecutionPaused })
      .from(companies).where(eq(companies.id, input.companyId)).for("update");
    if (!company) return null;
    if (company.paused !== input.paused) {
      await tx.update(companies).set({
        autonomousExecutionPaused: input.paused,
        updatedAt: new Date(),
      }).where(eq(companies.id, input.companyId));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "user",
        actorId: input.actorId,
        action: input.paused ? "autonomous_execution.paused" : "autonomous_execution.resumed",
        entityType: "company",
        entityId: input.companyId,
        details: { paused: input.paused },
      });
    }
    const [updated] = await tx.select({ paused: companies.autonomousExecutionPaused })
      .from(companies).where(eq(companies.id, input.companyId));
    return { companyId: input.companyId, paused: updated.paused };
  });
}

/** Lock the company row shared with admission; toggles never wake an agent. */
export async function setScopedAutonomousExecutionPause(
  db: Db,
  input: { companyId: string; scopeType: "agent" | "task"; scopeId: string; paused: boolean; actorId: string },
) {
  return db.transaction(async (tx) => {
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, input.companyId)).for("update");
    if (!company) return null;
    const table = input.scopeType === "agent" ? agents : issues;
    const [current] = await tx.select({ id: table.id, paused: table.autonomousExecutionPaused })
      .from(table).where(and(eq(table.id, input.scopeId), eq(table.companyId, input.companyId)));
    if (!current) return null;
    if (current.paused !== input.paused) {
      await tx.update(table).set({ autonomousExecutionPaused: input.paused })
        .where(and(eq(table.id, input.scopeId), eq(table.companyId, input.companyId)));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "user",
        actorId: input.actorId,
        action: input.paused ? "autonomous_execution.scoped_paused" : "autonomous_execution.scoped_resumed",
        entityType: input.scopeType === "agent" ? "agent" : "issue",
        entityId: input.scopeId,
        details: { paused: input.paused, scopeType: input.scopeType },
      });
    }
    const [updated] = await tx.select({ paused: table.autonomousExecutionPaused }).from(table)
      .where(and(eq(table.id, input.scopeId), eq(table.companyId, input.companyId)));
    return { companyId: input.companyId, scopeType: input.scopeType, scopeId: input.scopeId, paused: updated.paused };
  });
}
