import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies } from "@paperclipai/db";

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
