import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  activityLog,
  heartbeatRuns,
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "./issue-dependency-wakeups.js";

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function allowsPreCutoffDependencyTransition(
  db: Db,
  params: {
    cutoff: Date;
    companyId: string;
    agentId: string;
    issueId: string;
    source: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail: "manual" | "ping" | "callback" | "system" | null;
    reason: string | null;
    contextSnapshot: Record<string, unknown>;
  },
) {
  if (
    params.source !== "automation" ||
    params.triggerDetail !== "system" ||
    params.reason !== ISSUE_BLOCKERS_RESOLVED_WAKE_REASON
  ) {
    return false;
  }
  const blockerIssueId = readNonEmptyString(
    params.contextSnapshot.resolvedBlockerIssueId,
  );
  const completionRunId = readNonEmptyString(
    params.contextSnapshot.causalCompletionRunId,
  );
  if (!blockerIssueId || !completionRunId) return false;

  const [target, blocker, completionRun, finalization, relation, authorization] =
    await Promise.all([
      db.select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      }).from(issues).where(and(
        eq(issues.id, params.issueId),
        eq(issues.companyId, params.companyId),
      )).then((rows) => rows[0] ?? null),
      db.select({ status: issues.status, projectId: issues.projectId })
        .from(issues).where(and(
          eq(issues.id, blockerIssueId),
          eq(issues.companyId, params.companyId),
        )).then((rows) => rows[0] ?? null),
      db.select({
        nativeIssueId: heartbeatRuns.nativeIssueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, completionRunId),
        eq(heartbeatRuns.companyId, params.companyId),
        eq(heartbeatRuns.agentId, params.agentId),
        eq(heartbeatRuns.status, "succeeded"),
        gte(heartbeatRuns.createdAt, params.cutoff),
      )).then((rows) => rows[0] ?? null),
      db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, params.companyId),
        eq(activityLog.runId, completionRunId),
        eq(activityLog.agentId, params.agentId),
        eq(activityLog.action, "issue.updated"),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, blockerIssueId),
        sql`${activityLog.details} ->> 'status' = 'done'`,
        gte(activityLog.createdAt, params.cutoff),
      )).limit(1).then((rows) => rows[0] ?? null),
      db.select({ id: issueRelations.id })
        .from(issueRelations).where(and(
          eq(issueRelations.companyId, params.companyId),
          eq(issueRelations.issueId, blockerIssueId),
          eq(issueRelations.relatedIssueId, params.issueId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.resolutionState, "resolved"),
          isNotNull(issueRelations.resolutionEvidence),
        )).then((rows) => rows[0] ?? null),
      db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, params.companyId),
        eq(activityLog.action, "issue.updated"),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, params.issueId),
        eq(activityLog.actorType, "user"),
        gte(activityLog.createdAt, params.cutoff),
        sql`${activityLog.details} ->> 'authorizationReason' = 'allow_board_actor'`,
        sql`${activityLog.details} #>> '{executionWorkspaceSettings,mode}' = 'isolated_workspace'`,
        sql`${activityLog.details} #>> '{executionWorkspaceSettings,workspaceStrategy,type}' = 'git_worktree'`,
      )).limit(1).then((rows) => rows[0] ?? null),
    ]);
  if (!target || !blocker || !completionRun || !finalization || !relation || !authorization) {
    return false;
  }
  const targetWorkspaceSettings = parseObject(target.executionWorkspaceSettings);
  const targetWorkspaceStrategy = parseObject(
    targetWorkspaceSettings.workspaceStrategy,
  );
  const completionContext = parseObject(completionRun.contextSnapshot);
  const completionIssueMatches =
    completionRun.nativeIssueId === blockerIssueId ||
    readNonEmptyString(completionContext.issueId) === blockerIssueId ||
    readNonEmptyString(completionContext.taskId) === blockerIssueId;
  return (
    target.status === "blocked" &&
    target.assigneeAgentId === params.agentId &&
    blocker.status === "done" &&
    target.projectId === blocker.projectId &&
    (target.executionWorkspacePreference === "isolated_workspace" ||
      target.executionWorkspacePreference === "reuse_existing") &&
    readNonEmptyString(targetWorkspaceSettings.mode) === "isolated_workspace" &&
    readNonEmptyString(targetWorkspaceStrategy.type) === "git_worktree" &&
    completionIssueMatches
  );
}
