import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type {
  ChatTaskDispatchIssue,
  ChatTaskDispatchRepository,
} from "./chat-task-dispatch.js";

export function createChatTaskDispatchRepository(
  db: Db,
): ChatTaskDispatchRepository {
  return {
    findAgentsByExactName(companyId, agentName) {
      return db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            notInArray(agents.status, ["paused", "terminated"]),
            sql`lower(btrim(${agents.name})) = lower(btrim(${agentName}))`,
          ),
        )
        .orderBy(asc(agents.id))
        .limit(2);
    },

    async listRunnableIssueCandidates(
      companyId,
      agentId,
    ): Promise<ChatTaskDispatchIssue[]> {
      return db
        .select({
          id: issues.id,
          identifier: sql<string>`coalesce(${issues.identifier}, ${issues.id}::text)`,
          title: issues.title,
          status: issues.status,
          hasUnresolvedBlockers: sql<boolean>`false`,
          hasActiveExecution: sql<boolean>`false`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.assigneeAgentId, agentId),
            inArray(issues.status, ["todo", "in_progress"]),
            sql`not exists (
              select 1 from ${issueRelations}
              where ${issueRelations.companyId} = ${companyId}
                and ${issueRelations.relatedIssueId} = ${issues.id}
                and ${issueRelations.type} = 'blocks'
                and ${issueRelations.resolutionState} = 'unresolved'
            )`,
            sql`not exists (
              select 1 from ${heartbeatRuns}
              where ${heartbeatRuns.companyId} = ${companyId}
                and ${heartbeatRuns.agentId} = ${agentId}
                and ${heartbeatRuns.status} in ('queued', 'scheduled_retry', 'running')
            )`,
            sql`not exists (
              select 1 from ${agentWakeupRequests}
              where ${agentWakeupRequests.companyId} = ${companyId}
                and ${agentWakeupRequests.agentId} = ${agentId}
                and ${agentWakeupRequests.status} in ('queued', 'claimed', 'deferred')
            )`,
          ),
        )
        .orderBy(asc(issues.identifier), asc(issues.id))
        .limit(2);
    },
  };
}
