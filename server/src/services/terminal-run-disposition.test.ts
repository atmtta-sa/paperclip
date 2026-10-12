import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  automaticSuccessorIntents,
  autonomousBudgetReservations,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueService } from "./issues.js";
import type { BoundRunDisposition } from "./productive-continuation.js";
import { terminalRunDispositionService } from "./terminal-run-disposition.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

type Fixture = {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  reservationId: string;
  workspaceId: string;
};

describeEmbeddedPostgres("terminal run disposition finalization", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-terminal-disposition-",
    );
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(
    overrides: {
      issueStatus?: string;
      issueAssigneeAgentId?: string | null;
      issueExecutionRunId?: string | null;
      issueConversationAgentId?: string | null;
      reservation?: "reconciled" | "unsettled" | "missing";
      runStatus?: string;
      runContextIssueId?: string | null;
    } = {},
  ): Promise<Fixture> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const reservationId = randomUUID();
    const workspaceId = `workspace-${randomUUID().slice(0, 8)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal disposition",
      issuePrefix: `TD${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Terminal agent",
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (overrides.issueExecutionRunId) {
      // issues.execution_run_id references heartbeat_runs, so the newer run
      // that owns the execution pointer must exist first.
      await db.insert(heartbeatRuns).values({
        id: overrides.issueExecutionRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
    }
    const conversationAgentId = overrides.issueConversationAgentId ?? null;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Finalize me",
      status: overrides.issueStatus ?? "in_progress",
      assigneeAgentId:
        overrides.issueAssigneeAgentId === undefined
          ? agentId
          : overrides.issueAssigneeAgentId,
      executionRunId: overrides.issueExecutionRunId ?? null,
      conversationAgentId,
      conversationUserId: conversationAgentId ? "board-user-1" : null,
      conversationState: conversationAgentId ? "active" : null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: overrides.runStatus ?? "succeeded",
      finishedAt: new Date(),
      contextSnapshot:
        overrides.runContextIssueId === null
          ? {}
          : { issueId: overrides.runContextIssueId ?? issueId },
    });
    if (overrides.reservation !== "missing") {
      const reconciled = overrides.reservation !== "unsettled";
      await db.insert(autonomousBudgetReservations).values({
        id: reservationId,
        companyId,
        agentId,
        issueId,
        runId,
        chainRootRunId: runId,
        status: reconciled ? "reconciled" : "reserved",
        settlementState: reconciled ? "consumed" : null,
        reservedRequestCount: 1,
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
        reservedRuntimeMs: 2_000,
        reservedCostCents: 1,
        reservedCostMicrousd: 500,
        actualRequestCount: reconciled ? 1 : null,
        actualInputTokens: reconciled ? 100 : null,
        actualOutputTokens: reconciled ? 50 : null,
        actualRuntimeMs: reconciled ? 2_000 : null,
        actualCostMicrousd: reconciled ? 500 : null,
        billingMode: "metered_currency",
        monetaryApplicability: "applicable_per_request",
        provider: "openai",
        model: "gpt-5",
        providerRequestId: reconciled ? "req_terminal_1" : null,
        providerActivityOccurred: reconciled,
        reconciledAt: reconciled ? new Date() : null,
      });
    }
    return { companyId, agentId, issueId, runId, reservationId, workspaceId };
  }

  function boundDisposition(
    fixture: Fixture,
    overrides: Partial<BoundRunDisposition> = {},
  ): BoundRunDisposition {
    return {
      version: 2,
      kind: "complete",
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      runId: fixture.runId,
      workspaceId: fixture.workspaceId,
      ...overrides,
    };
  }

  async function finalize(
    fixture: Fixture,
    overrides: {
      disposition?: BoundRunDisposition;
      reservation?: "fetch" | "missing";
    } = {},
  ) {
    const svc = terminalRunDispositionService(db);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from companies where id = ${fixture.companyId} for update`,
      );
      const reservation =
        overrides.reservation === "missing"
          ? null
          : await tx
              .select()
              .from(autonomousBudgetReservations)
              .where(eq(autonomousBudgetReservations.runId, fixture.runId))
              .then((rows) => rows[0] ?? null);
      return svc.finalizeTerminalRunDisposition(tx as unknown as Db, {
        runId: fixture.runId,
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        issueId: fixture.issueId,
        workspaceId: fixture.workspaceId,
        disposition: overrides.disposition ?? boundDisposition(fixture),
        reservation,
        chainRootRunId: fixture.runId,
        authorizationBinding: {
          issueId: fixture.issueId,
          agentId: fixture.agentId,
          workspaceId: fixture.workspaceId,
          provider: "openai",
          model: "gpt-5",
          routePolicyId: null,
          routePolicyVersion: null,
          routePolicyDigest: null,
        },
        policyVersion: 1,
      });
    });
  }

  async function readIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function readIntents(companyId: string) {
    return db
      .select()
      .from(automaticSuccessorIntents)
      .where(eq(automaticSuccessorIntents.companyId, companyId));
  }

  async function countWakeupRequests(companyId: string) {
    const rows = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    return rows.length;
  }

  it("finalizes a bound complete disposition on an in-progress issue with a reconciled reservation", async () => {
    const fixture = await seedFixture();
    const result = await finalize(fixture);

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("finalized");
    expect(result!.intent).toMatchObject({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      agentId: fixture.agentId,
      predecessorRunId: fixture.runId,
      kind: "terminal",
      status: "materialized",
      reason: "run_disposition_complete",
      denialReason: null,
    });

    // The issue reads back done after commit, with terminal side effects applied.
    const issue = await readIssue(fixture.issueId);
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).not.toBeNull();

    // A terminal decision never enqueues a successor wake.
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  it("replays a committed terminal finalization without a duplicate mutation", async () => {
    const fixture = await seedFixture();
    const first = await finalize(fixture);
    expect(first!.outcome).toBe("finalized");
    const completedAt = (await readIssue(fixture.issueId))?.completedAt;

    const second = await finalize(fixture);
    expect(second!.outcome).toBe("replayed");
    expect(second!.intent.id).toBe(first!.intent.id);

    const intents = await readIntents(fixture.companyId);
    expect(intents).toHaveLength(1);
    expect((await readIssue(fixture.issueId))?.completedAt?.getTime()).toBe(
      completedAt?.getTime(),
    );
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  it.each([
    ["wrong issue", (f: Fixture) => boundDisposition(f, { issueId: randomUUID() })],
    ["wrong workspace", (f: Fixture) => boundDisposition(f, { workspaceId: "workspace-other" })],
    ["wrong agent", (f: Fixture) => boundDisposition(f, { agentId: randomUUID() })],
    ["wrong run", (f: Fixture) => boundDisposition(f, { runId: randomUUID() })],
    ["wrong company", (f: Fixture) => boundDisposition(f, { companyId: randomUUID() })],
  ])(
    "denies a terminal disposition with a %s binding without any mutation",
    async (_label, dispositionFor) => {
      const fixture = await seedFixture();
      const result = await finalize(fixture, {
        disposition: dispositionFor(fixture),
      });

      expect(result!.outcome).toBe("denied");
      expect(result!.intent).toMatchObject({
        kind: "terminal",
        status: "denied",
        denialReason: "terminal_binding_mismatch",
      });
      expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
      expect(await countWakeupRequests(fixture.companyId)).toBe(0);
    },
  );

  it("denies finalization when the issue assignee changed", async () => {
    const otherAgentId = randomUUID();
    const fixture = await seedFixture();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: fixture.companyId,
      name: "Other agent",
      role: "engineer",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(issues)
      .set({ assigneeAgentId: otherAgentId })
      .where(eq(issues.id, fixture.issueId));

    const result = await finalize(fixture);
    expect(result!.outcome).toBe("denied");
    expect(result!.intent.denialReason).toBe("terminal_assignee_mismatch");
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
  });

  it("denies finalization when a newer run owns the issue execution", async () => {
    const fixture = await seedFixture({
      issueExecutionRunId: randomUUID(),
    });
    const result = await finalize(fixture);
    expect(result!.outcome).toBe("denied");
    expect(result!.intent.denialReason).toBe("terminal_execution_run_mismatch");
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
  });

  it("denies finalization when the budget reservation is not durably reconciled", async () => {
    const fixture = await seedFixture({ reservation: "unsettled" });
    const result = await finalize(fixture);
    expect(result!.outcome).toBe("denied");
    expect(result!.intent.denialReason).toBe(
      "terminal_settlement_unreconciled",
    );
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  it("denies finalization when the budget reservation is missing", async () => {
    const fixture = await seedFixture({ reservation: "missing" });
    const result = await finalize(fixture, { reservation: "missing" });
    expect(result!.outcome).toBe("denied");
    expect(result!.intent.denialReason).toBe(
      "terminal_settlement_unreconciled",
    );
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
  });

  it.each(["blocked", "in_review", "cancelled", "backlog", "todo"])(
    "denies a complete disposition against a contradictory %s issue",
    async (issueStatus) => {
      const fixture = await seedFixture({ issueStatus });
      const result = await finalize(fixture);
      expect(result!.outcome).toBe("denied");
      expect(result!.intent.denialReason).toBe("disposition_state_mismatch");
      expect((await readIssue(fixture.issueId))?.status).toBe(issueStatus);
      expect(await countWakeupRequests(fixture.companyId)).toBe(0);
    },
  );

  it("confirms a complete disposition against an already-done issue without mutating it", async () => {
    const fixture = await seedFixture({ issueStatus: "done" });
    const result = await finalize(fixture);
    expect(result!.outcome).toBe("confirmed");
    expect(result!.intent).toMatchObject({
      kind: "terminal",
      status: "materialized",
      reason: "run_disposition_complete",
    });
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  it.each([
    ["blocked", "blocked"],
    ["needs_human", "blocked"],
    ["in_review", "in_review"],
    ["cancelled", "cancelled"],
  ] as const)(
    "confirms a bound %s disposition only when the issue already matches",
    async (kind, issueStatus) => {
      const matching = await seedFixture({ issueStatus });
      const confirmed = await finalize(matching, {
        disposition: boundDisposition(matching, { kind }),
      });
      expect(confirmed!.outcome).toBe("confirmed");
      expect(confirmed!.intent).toMatchObject({
        kind: "terminal",
        status: "materialized",
        reason: `run_disposition_${kind}`,
      });
      expect((await readIssue(matching.issueId))?.status).toBe(issueStatus);

      const contradictory = await seedFixture({ issueStatus: "in_progress" });
      const denied = await finalize(contradictory, {
        disposition: boundDisposition(contradictory, { kind }),
      });
      expect(denied!.outcome).toBe("denied");
      expect(denied!.intent.denialReason).toBe("disposition_state_mismatch");
      expect((await readIssue(contradictory.issueId))?.status).toBe(
        "in_progress",
      );
    },
  );

  it("arbitrates concurrent finalization to exactly one terminal decision", async () => {
    const fixture = await seedFixture();
    const [first, second] = await Promise.all([
      finalize(fixture),
      finalize(fixture),
    ]);
    const outcomes = [first!.outcome, second!.outcome].sort();
    expect(outcomes).toEqual(["finalized", "replayed"]);
    expect(first!.intent.id).toBe(second!.intent.id);

    const intents = await readIntents(fixture.companyId);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ kind: "terminal", status: "materialized" });
    expect((await readIssue(fixture.issueId))?.status).toBe("done");
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  it("rolls back both the issue transition and the intent when the transaction fails", async () => {
    const fixture = await seedFixture();
    const svc = terminalRunDispositionService(db);
    const sentinel = new Error("forced transaction failure");
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from companies where id = ${fixture.companyId} for update`,
        );
        const reservation = await tx
          .select()
          .from(autonomousBudgetReservations)
          .where(eq(autonomousBudgetReservations.runId, fixture.runId))
          .then((rows) => rows[0] ?? null);
        const result = await svc.finalizeTerminalRunDisposition(
          tx as unknown as Db,
          {
            runId: fixture.runId,
            companyId: fixture.companyId,
            agentId: fixture.agentId,
            issueId: fixture.issueId,
            workspaceId: fixture.workspaceId,
            disposition: boundDisposition(fixture),
            reservation,
            chainRootRunId: fixture.runId,
            authorizationBinding: { issueId: fixture.issueId },
            policyVersion: 1,
          },
        );
        expect(result!.outcome).toBe("finalized");
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);

    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    expect(await readIntents(fixture.companyId)).toHaveLength(0);
  });

  it("records a durable denial instead of completing when a review guard conflicts", async () => {
    const fixture = await seedFixture();
    await db
      .update(issues)
      .set({
        conversationAgentId: fixture.agentId,
        conversationUserId: "board-user-1",
        conversationState: "active",
      })
      .where(eq(issues.id, fixture.issueId));

    const result = await finalize(fixture);
    expect(result!.outcome).toBe("denied");
    expect(result!.intent).toMatchObject({
      kind: "terminal",
      status: "denied",
      denialReason: "terminal_update_conflict",
    });
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  it("denies an unscoped run before any mutation", async () => {
    const fixture = await seedFixture({ runContextIssueId: null });
    const result = await finalize(fixture, {
      disposition: boundDisposition(fixture, { issueId: fixture.issueId }),
    });
    expect(result!.outcome).toBe("denied");
    expect(result!.intent.denialReason).toBe(
      "terminal_settlement_unreconciled",
    );
    expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");
  });

  it("makes a blocked dependent dependency-ready only after the blocker commits done", async () => {
    const fixture = await seedFixture();
    const dependentId = randomUUID();
    await db.insert(issues).values({
      id: dependentId,
      companyId: fixture.companyId,
      title: "Dependent",
      status: "todo",
      assigneeAgentId: fixture.agentId,
    });
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      relatedIssueId: dependentId,
      type: "blocks",
    });

    const svc = issueService(db);
    const before = await svc.listDependencyReadiness(fixture.companyId, [
      dependentId,
    ]);
    expect(before.get(dependentId)?.isDependencyReady).toBe(false);

    const result = await finalize(fixture);
    expect(result!.outcome).toBe("finalized");

    const after = await svc.listDependencyReadiness(fixture.companyId, [
      dependentId,
    ]);
    expect(after.get(dependentId)?.isDependencyReady).toBe(true);
    // The terminal decision itself enqueues nothing; the existing dependency
    // wake mechanism acts independently after the committed transition.
    expect(await countWakeupRequests(fixture.companyId)).toBe(0);
  });

  describe("replayCommittedTerminalFinalization backstop", () => {
    it("replays only an already-committed materialized terminal intent", async () => {
      const fixture = await seedFixture();
      const svc = terminalRunDispositionService(db);

      // No intent recorded yet: nothing to replay.
      const missing = await svc.replayCommittedTerminalFinalization({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        runId: fixture.runId,
      });
      expect(missing.kind).toBe("skip");
      expect((await readIssue(fixture.issueId))?.status).toBe("in_progress");

      // Commit the terminal decision, then strand the issue (simulating a
      // legacy partially-applied finalization).
      const committed = await finalize(fixture);
      expect(committed!.outcome).toBe("finalized");
      await db
        .update(issues)
        .set({ status: "in_progress", completedAt: null })
        .where(eq(issues.id, fixture.issueId));

      const replayed = await svc.replayCommittedTerminalFinalization({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        runId: fixture.runId,
      });
      expect(replayed.kind).toBe("replayed");
      expect((await readIssue(fixture.issueId))?.status).toBe("done");

      const again = await svc.replayCommittedTerminalFinalization({
        companyId: fixture.companyId,
        issueId: fixture.issueId,
        runId: fixture.runId,
      });
      expect(again.kind).toBe("already_done");
      expect(await readIntents(fixture.companyId)).toHaveLength(1);
      expect(await countWakeupRequests(fixture.companyId)).toBe(0);
    });

    it("never replays a denied intent and never overwrites contradictory state", async () => {
      const deniedFixture = await seedFixture({ reservation: "unsettled" });
      const svc = terminalRunDispositionService(db);
      const denied = await finalize(deniedFixture);
      expect(denied!.outcome).toBe("denied");
      const deniedReplay = await svc.replayCommittedTerminalFinalization({
        companyId: deniedFixture.companyId,
        issueId: deniedFixture.issueId,
        runId: deniedFixture.runId,
      });
      expect(deniedReplay.kind).toBe("skip");
      expect((await readIssue(deniedFixture.issueId))?.status).toBe(
        "in_progress",
      );

      const cancelledFixture = await seedFixture();
      const committed = await finalize(cancelledFixture);
      expect(committed!.outcome).toBe("finalized");
      await db
        .update(issues)
        .set({ status: "cancelled", completedAt: null })
        .where(eq(issues.id, cancelledFixture.issueId));
      const conflicted = await svc.replayCommittedTerminalFinalization({
        companyId: cancelledFixture.companyId,
        issueId: cancelledFixture.issueId,
        runId: cancelledFixture.runId,
      });
      expect(conflicted.kind).toBe("conflicted");
      expect((await readIssue(cancelledFixture.issueId))?.status).toBe(
        "cancelled",
      );
    });
  });
});
