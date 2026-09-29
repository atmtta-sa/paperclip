import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

const AGENT_RUN_ADMISSION_LOCK_PREFIX = "heartbeat-agent-run-admission:";

/**
 * Serialize an agent's queued-to-running admission across server processes.
 * The caller must claim the queued run in the same transaction before returning.
 */
export async function claimAgentRunSlot(
  tx: Db,
  input: { agentId: string; maxConcurrentRuns: number },
): Promise<boolean> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${AGENT_RUN_ADMISSION_LOCK_PREFIX}${input.agentId}`}, 0))`,
  );

  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
      ),
    );

  return Number(count ?? 0) < Math.max(1, input.maxConcurrentRuns);
}
