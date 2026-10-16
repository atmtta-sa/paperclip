import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  autonomousBudgetReservations,
  budgetIncidents,
  budgetPolicies,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { seedSyntheticCompanyBudgets } from "./helpers/synthetic-autonomous-budgets.js";
import { heartbeatService, resolveHeartbeatSchedulingSuppression } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  buildIssueBlockerStateFingerprint,
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat worktree suppression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat worktree suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-worktree-suppression-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A live wakeup claims a run and dispatches its execution
    // fire-and-forget, so a run or wakeup can still write heartbeat_runs and
    // issues rows when teardown starts and would race the deletes. The heartbeat
    // service tracks in-flight run and wakeup promises in module state shared
    // across service instances, so a fresh instance here drains the runs the
    // per-test instances dispatched.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(activityLog);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(autonomousBudgetReservations);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function insertAgentAndIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worktree Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function armWorktreeRunExecution(cutoff: Date) {
    await instanceSettingsService(db, {
      runtimeEnv: {
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_INSTANCE_ID: "test-worktree",
      },
      now: () => cutoff,
    }).updateExperimental({ enableWorktreeRunExecution: true });
  }

  async function waitForCompletedRun(runId: string, agentId: string) {
    let latestStatus: string | null = null;
    let latestLastRunId: string | null = null;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      const state = await db
        .select({ lastRunId: agentRuntimeState.lastRunId })
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId))
        .then((rows) => rows[0] ?? null);

      latestStatus = run?.status ?? null;
      latestLastRunId = state?.lastRunId ?? null;

      if (run && run.status !== "queued" && run.status !== "running" && state?.lastRunId === runId) {
        return run.status;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(
      `Timed out waiting for heartbeat run ${runId} to finish; latest status=${latestStatus ?? "missing"}, runtime lastRunId=${latestLastRunId ?? "missing"}`,
    );
  }

  it("suppresses new assignment wakes in worktree instances without creating heartbeat runs", async () => {
    const { agentId, issueId } = await insertAgentAndIssue();
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "true" },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });

    expect(run).toBeNull();

    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.scheduling_suppressed",
    });
    expect(wakeup?.payload).toMatchObject({
      issueId,
      heartbeatSkip: { reason: "worktree_instance" },
    });
  });

  it("does not replay copied queued runs or timer wakes while worktree scheduling is suppressed", async () => {
    const { companyId, agentId, issueId } = await insertAgentAndIssue();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_IN_WORKTREE: "true" },
    });

    await heartbeat.resumeQueuedRuns();
    const tick = await heartbeat.tickTimers(new Date("2026-07-07T00:10:00Z"));

    expect(tick).toEqual({ checked: 0, enqueued: 0, skipped: 0 });

    const [copiedRun] = await db
      .select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(copiedRun).toMatchObject({
      status: "queued",
      startedAt: null,
    });

    const runningCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runningCount).toBe(0);
  });

  it("skips pre-cutoff system wakes but allows user wakes in an armed worktree", async () => {
    const { agentId, issueId } = await insertAgentAndIssue();
    await armWorktreeRunExecution(new Date(Date.now() + 1_000));
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_INSTANCE_ID: "test-worktree",
      },
    });

    const systemRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      payload: { issueId },
      contextSnapshot: { issueId },
      requestedByActorType: "system",
    });
    expect(systemRun).toBeNull();

    const skippedWake = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .orderBy(sql`${agentWakeupRequests.createdAt} desc`)
      .limit(1)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ reason: "heartbeat.worktree_execution_cutoff" });
    expect(skippedWake?.payload).toMatchObject({
      heartbeatSkip: { reason: "worktree_execution_cutoff", issueId },
    });

    const userRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      payload: { issueId },
      contextSnapshot: { issueId, skipIssueComment: true },
      requestedByActorType: "user",
      requestedByActorId: "operator",
    });
    expect(userRun).not.toBeNull();
    await heartbeat.waitForRunExecutionDrain(userRun!.id);
  }, 10_000);

  it("allows a productive successor bound to a post-cutoff predecessor for a pre-cutoff issue", async () => {
    const { companyId, agentId, issueId } = await insertAgentAndIssue();
    const cutoff = new Date(Date.now() - 1_000);
    await db
      .update(issues)
      .set({ createdAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(issues.id, issueId));
    await armWorktreeRunExecution(cutoff);
    const predecessorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: predecessorRunId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      status: "succeeded",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId },
      createdAt: new Date(cutoff.getTime() + 500),
      startedAt: new Date(cutoff.getTime() + 500),
      finishedAt: new Date(cutoff.getTime() + 750),
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_INSTANCE_ID: "test-worktree",
      },
    });

    const successor = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      payload: { issueId, intent: "continue_same_issue" },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        retryOfRunId: predecessorRunId,
        parentRunId: predecessorRunId,
        automaticSuccessorIntentId: randomUUID(),
        productiveContinuation: true,
      },
      requestedByActorType: "system",
    });

    expect(successor).not.toBeNull();
    await heartbeat.waitForRunExecutionDrain(successor!.id);
  }, 10_000);

  it("allows a dependency wake bound to the exact post-cutoff completion of an explicitly configured pre-cutoff target", async () => {
    const { companyId, agentId, issueId: dependentIssueId } = await insertAgentAndIssue();
    const blockerIssueId = randomUUID();
    const completionRunId = randomUUID();
    const unboundSucceededRunId = randomUUID();
    const cutoff = new Date(Date.now() - 2_000);
    const blockedTransitionAt = new Date(cutoff.getTime() - 2_000);
    const configuredAt = new Date(cutoff.getTime() + 250);
    const completedAt = new Date(cutoff.getTime() + 500);
    await db.update(issues).set({
      status: "blocked",
      createdAt: new Date(cutoff.getTime() - 3_000),
      blockedTransitionAt,
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree" },
      },
      updatedAt: configuredAt,
    }).where(eq(issues.id, dependentIssueId));
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Completed blocker",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      completedAt,
      createdAt: new Date(cutoff.getTime() - 3_000),
      updatedAt: completedAt,
    });
    const blockerState = {
      blockerIssueId,
      blockerKind: "issue_dependency",
      requiredEvidenceVersion: "issue_done_v1",
      resolutionState: "resolved" as const,
      evidenceRevision: 1,
    };
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
      ...blockerState,
      resolutionEvidence: {
        blockerIssueId,
        status: "done",
        statusVersion: 1,
        completedAt: completedAt.toISOString(),
      },
      resolvedAt: completedAt,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: completionRunId,
        companyId,
        agentId,
        nativeIssueId: blockerIssueId,
        status: "succeeded",
        responsibleUserId: "responsible-user",
        contextSnapshot: { issueId: blockerIssueId, taskId: blockerIssueId },
        createdAt: completedAt,
        startedAt: completedAt,
        finishedAt: completedAt,
      },
      {
        id: unboundSucceededRunId,
        companyId,
        agentId,
        nativeIssueId: blockerIssueId,
        status: "succeeded",
        responsibleUserId: "responsible-user",
        contextSnapshot: { issueId: blockerIssueId, taskId: blockerIssueId },
        createdAt: new Date(completedAt.getTime() + 1),
        startedAt: new Date(completedAt.getTime() + 1),
        finishedAt: new Date(completedAt.getTime() + 1),
      },
    ]);
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: completionRunId,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockerIssueId,
      details: { status: "done" },
      createdAt: completedAt,
    });
    await armWorktreeRunExecution(cutoff);
    const blockerStateFingerprint = buildIssueBlockerStateFingerprint([blockerState]);
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_IN_WORKTREE: "true",
        PAPERCLIP_INSTANCE_ID: "test-worktree",
      },
    });

    const wakeDependency = (
      causalCompletionRunId: string | null,
    ) => heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: dependentIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
        ...(causalCompletionRunId ? { causalCompletionRunId } : {}),
      },
      contextSnapshot: {
        issueId: dependentIssueId,
        taskId: dependentIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerIssueId,
        ...(causalCompletionRunId ? { causalCompletionRunId } : {}),
      },
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        blockerStates: [blockerState],
        blockedTransitionAt,
      }),
      blockerStateFingerprint,
      requestedByActorType: "system",
      requestedByActorId: "dependency-reconciliation",
    });

    await expect(wakeDependency(completionRunId)).resolves.toBeNull();
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: dependentIssueId,
      details: {
        authorizationReason: "allow_board_actor",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      },
      createdAt: configuredAt,
    });
    await expect(wakeDependency(null)).resolves.toBeNull();
    await expect(wakeDependency(randomUUID())).resolves.toBeNull();
    await expect(wakeDependency(unboundSucceededRunId)).resolves.toBeNull();
    const targetRunsBeforeAuthorizedWake = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${dependentIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(targetRunsBeforeAuthorizedWake).toBe(0);

    const successor = await wakeDependency(completionRunId);

    expect(successor).not.toBeNull();
    await heartbeat.waitForRunExecutionDrain(successor!.id);
  }, 10_000);

  it("creates live-plane assignment runs but fails closed without usage evidence", async () => {
    const { companyId, agentId, issueId } = await insertAgentAndIssue();
    await db.update(companies).set({ autonomousExecutionPaused: false }).where(eq(companies.id, companyId));
    await seedSyntheticCompanyBudgets(db, companyId);
    await db
      .update(issues)
      .set({ status: "in_review", updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned", skipIssueComment: true },
      requestedByActorType: "system",
      requestedByActorId: "issue_assignment",
    });

    expect(run).not.toBeNull();
    const terminalStatus = await waitForCompletedRun(run!.id, agentId);
    await heartbeat.waitForRunExecutionDrain(run!.id);
    expect(terminalStatus).toBe("failed");
    const [failedRun] = await db.select({ errorCode: heartbeatRuns.errorCode,
      workOutcome: heartbeatRuns.workOutcome }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(failedRun).toMatchObject({ errorCode: "telemetry_missing", workOutcome: "telemetry_missing" });

    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .orderBy(heartbeatRuns.createdAt);
    expect(runs.map((entry) => entry.contextSnapshot?.wakeReason)).toEqual([
      "issue_assigned",
    ]);
  }, 10_000);

  it("recognizes explicit restore-in-progress suppression", () => {
    expect(resolveHeartbeatSchedulingSuppression({
      PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true",
    })).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });
});
