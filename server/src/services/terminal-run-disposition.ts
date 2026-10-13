import { and, eq, sql } from "drizzle-orm";
import {
  automaticSuccessorIntents,
  autonomousBudgetReservations,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import { HttpError } from "../errors.js";
import {
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import { lockEligibleAutomaticSuccessorSettlement } from "./automatic-successor-settlement.js";
import {
  claimAutomaticSuccessorIntent,
  type BoundRunDisposition,
  type TerminalRunDispositionKind,
} from "./productive-continuation.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Reservation = typeof autonomousBudgetReservations.$inferSelect;
type AutomaticSuccessorIntent = typeof automaticSuccessorIntents.$inferSelect;

/**
 * Terminal run dispositions: Paperclip, not the model, is the atomic terminal
 * authority. A bound version-2 terminal disposition (bindings injected by the
 * adapter from trusted execution context) is validated under company -> issue
 * -> run -> reservation locks, and an accepted `complete` transitions that
 * exact issue to `done` and records the accepted terminal intent in the same
 * transaction. Every failure mode fails closed: no issue mutation, no
 * successor wake, and a durable denial recorded against the run.
 */

export const TERMINAL_DISPOSITION_TARGET_STATUS: Record<
  TerminalRunDispositionKind,
  string
> = {
  complete: "done",
  blocked: "blocked",
  needs_human: "blocked",
  in_review: "in_review",
  cancelled: "cancelled",
};

export type TerminalRunDispositionDenial =
  | "terminal_unsupported_contract"
  | "terminal_run_not_successful"
  | "terminal_binding_mismatch"
  | "terminal_assignee_mismatch"
  | "terminal_execution_run_mismatch"
  | "terminal_settlement_unreconciled"
  | "disposition_state_mismatch"
  | "terminal_update_conflict";

export type TerminalRunDispositionOutcome =
  // The issue transitioned to the terminal status in this transaction.
  | "finalized"
  // The issue already held the disposition's terminal status; acceptance recorded.
  | "confirmed"
  // A committed terminal intent for this run already exists; no mutation.
  | "replayed"
  // Durable denial recorded; no mutation, no successor.
  | "denied"
  // A committed record contradicts this finalization; no mutation.
  | "conflicted";

export type TerminalRunDispositionResult = {
  outcome: TerminalRunDispositionOutcome;
  intent: AutomaticSuccessorIntent;
  denialReason: string | null;
  created: boolean;
  postCommitActions: IssuePostCommitAction[];
  activityPublications: ActivityPublication[];
};

export type TerminalRunDispositionInput = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  workspaceId: string | null;
  disposition: BoundRunDisposition;
  reservation: Reservation | null;
  chainRootRunId: string;
  authorizationBinding: Record<string, unknown>;
  policyVersion: number;
};

export type TerminalFinalizationReplayResult =
  | { kind: "replayed" }
  | { kind: "already_done" }
  | { kind: "skip" }
  | { kind: "suppressed" }
  | { kind: "conflicted" };

function isHttpConflict(error: unknown): error is HttpError {
  return (
    error instanceof HttpError && (error.status === 409 || error.status === 422)
  );
}

export function terminalRunDispositionService(db: Db) {
  const issuesSvc = issueService(db);

  async function recordTerminalIntent(
    tx: Db,
    input: TerminalRunDispositionInput,
    decision: { status: "materialized"; denialReason?: null } | { status: "denied"; denialReason: string },
  ) {
    const reservation = input.reservation;
    return claimAutomaticSuccessorIntent(tx, {
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      predecessorRunId: input.runId,
      chainRootRunId: input.chainRootRunId,
      kind: "terminal",
      status: decision.status,
      reason: `run_disposition_${input.disposition.kind}`,
      denialReason: decision.denialReason ?? null,
      checkpointRef: null,
      nextAction: null,
      authorizationBinding: input.authorizationBinding,
      policyVersion: input.policyVersion,
      budgetSnapshot: reservation
        ? {
            chainRootRunId: input.chainRootRunId,
            reservedRequestCount: reservation.reservedRequestCount,
            actualRequestCount: reservation.actualRequestCount,
          }
        : null,
    });
  }

  async function markIntentDenied(
    tx: Db,
    intentId: string,
    denialReason: TerminalRunDispositionDenial,
  ) {
    const [updated] = await tx
      .update(automaticSuccessorIntents)
      .set({ status: "denied", denialReason, updatedAt: new Date() })
      .where(
        and(
          eq(automaticSuccessorIntents.id, intentId),
          eq(automaticSuccessorIntents.status, "materialized"),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Validate and apply a bound terminal disposition inside the caller's
   * transaction. The caller must already hold the company row lock (heartbeat
   * lock order: company -> issue -> run -> reservation); this function
   * re-locks the issue and run rows it validates.
   *
   * Returns null when the issue or run row vanished mid-finalization (the
   * caller treats the disposition as handled and moves on).
   */
  async function finalizeTerminalRunDisposition(
    tx: Db,
    input: TerminalRunDispositionInput,
  ): Promise<TerminalRunDispositionResult | null> {
    const postCommitActions: IssuePostCommitAction[] = [];
    const activityPublications: ActivityPublication[] = [];
    const { disposition } = input;

    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update");
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        ),
      )
      .for("update");
    if (!issue || !run) return null;

    // Trusted binding comparison: the normalized disposition must reproduce
    // the exact execution identity under the locks, not merely claim it.
    let denial: TerminalRunDispositionDenial | null = null;
    if (disposition.version !== 2) {
      denial = "terminal_unsupported_contract";
    } else if (run.status !== "succeeded") {
      denial = "terminal_run_not_successful";
    } else if (
      disposition.companyId !== run.companyId ||
      disposition.issueId !== issue.id ||
      disposition.agentId !== run.agentId ||
      disposition.runId !== run.id ||
      (disposition.workspaceId ?? null) !== (input.workspaceId ?? null)
    ) {
      denial = "terminal_binding_mismatch";
    } else if (issue.assigneeAgentId !== run.agentId) {
      denial = "terminal_assignee_mismatch";
    } else if (
      issue.executionRunId !== null &&
      issue.executionRunId !== run.id
    ) {
      // The execution pointer is cleared before disposition handling; a live
      // pointer to another run means a newer execution owns the issue.
      denial = "terminal_execution_run_mismatch";
    } else if (!(await lockEligibleAutomaticSuccessorSettlement(tx, run))) {
      denial = "terminal_settlement_unreconciled";
    }

    const targetStatus = TERMINAL_DISPOSITION_TARGET_STATUS[disposition.kind];
    let transition = false;
    if (!denial) {
      if (disposition.kind === "complete") {
        if (issue.status === "in_progress") {
          transition = true;
        } else if (issue.status !== "done") {
          denial = "disposition_state_mismatch";
        }
      } else if (issue.status !== targetStatus) {
        denial = "disposition_state_mismatch";
      }
    }

    // Record the terminal intent before mutating: the first committed
    // decision for this run is durable, and a concurrent or repeated
    // finalization replays it instead of re-deciding.
    const claimed = await recordTerminalIntent(
      tx,
      input,
      denial
        ? { status: "denied", denialReason: denial }
        : { status: "materialized" },
    );
    if (!claimed.created) {
      const existing = claimed.intent;
      if (existing.kind === "terminal" && existing.status === "materialized") {
        return {
          outcome: "replayed",
          intent: existing,
          denialReason: null,
          created: false,
          postCommitActions,
          activityPublications,
        };
      }
      return {
        outcome: existing.status === "denied" ? "denied" : "conflicted",
        intent: existing,
        denialReason: existing.denialReason,
        created: false,
        postCommitActions,
        activityPublications,
      };
    }
    if (denial) {
      return {
        outcome: "denied",
        intent: claimed.intent,
        denialReason: denial,
        created: true,
        postCommitActions,
        activityPublications,
      };
    }
    if (!transition) {
      return {
        outcome: "confirmed",
        intent: claimed.intent,
        denialReason: null,
        created: true,
        postCommitActions,
        activityPublications,
      };
    }

    let updated: { status: string; companyId: string } | null = null;
    try {
      updated = await issuesSvc.update(
        issue.id,
        {
          status: "done",
          companyGuard: run.companyId,
          actorAgentId: run.agentId,
        },
        tx,
        activityPublications,
        postCommitActions,
      );
    } catch (error) {
      if (isHttpConflict(error)) {
        // A guard inside the canonical issue mutation (for example a pending
        // connection review) contradicts completion. Fail closed with a
        // durable denial; the issue is untouched.
        const deniedIntent = await markIntentDenied(
          tx,
          claimed.intent.id,
          "terminal_update_conflict",
        );
        return {
          outcome: "denied",
          intent: deniedIntent ?? {
            ...claimed.intent,
            status: "denied" as const,
            denialReason: "terminal_update_conflict",
          },
          denialReason: "terminal_update_conflict",
          created: true,
          postCommitActions: [],
          activityPublications: [],
        };
      }
      // Unexpected failure: roll back both the issue transition and the
      // terminal intent by aborting the caller's transaction.
      throw error;
    }
    if (!updated || updated.status !== "done" || updated.companyId !== run.companyId) {
      throw new Error(
        `Terminal finalization read-back failed for issue ${issue.id} on run ${run.id}`,
      );
    }
    return {
      outcome: "finalized",
      intent: claimed.intent,
      denialReason: null,
      created: true,
      postCommitActions,
      activityPublications,
    };
  }

  /**
   * Recovery backstop: replay an already-committed terminal-finalization
   * intent for the same issue/run. This never re-calls a provider, never
   * selects other work, never creates budget authority, and never overwrites
   * a contradictory issue state — it only re-applies a `done` transition that
   * was already accepted and recorded.
   */
  async function replayCommittedTerminalFinalization(input: {
    companyId: string;
    issueId: string;
    runId: string;
  }): Promise<TerminalFinalizationReplayResult> {
    const [intent] = await db
      .select()
      .from(automaticSuccessorIntents)
      .where(
        and(
          eq(automaticSuccessorIntents.companyId, input.companyId),
          eq(automaticSuccessorIntents.issueId, input.issueId),
          eq(automaticSuccessorIntents.predecessorRunId, input.runId),
          eq(automaticSuccessorIntents.kind, "terminal"),
        ),
      )
      .limit(1);
    // Only an accepted `complete` is terminal-finalization authority.
    if (!intent) return { kind: "skip" };
    if (
      intent.status !== "materialized" ||
      intent.reason !== "run_disposition_complete"
    ) {
      return { kind: "suppressed" };
    }

    const postCommitActions: IssuePostCommitAction[] = [];
    const activityPublications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from companies where id = ${input.companyId} for update`,
      );
      const [issue] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .for("update");
      if (!issue) return { kind: "skip" } as const;
      if (issue.status === "done") return { kind: "already_done" } as const;
      if (
        issue.status !== "in_progress" ||
        issue.assigneeAgentId !== intent.agentId ||
        (issue.executionRunId !== null && issue.executionRunId !== input.runId)
      ) {
        return { kind: "conflicted" } as const;
      }
      try {
        const updated = await issuesSvc.update(
          issue.id,
          {
            status: "done",
            companyGuard: input.companyId,
            actorAgentId: intent.agentId,
          },
          tx,
          activityPublications,
          postCommitActions,
        );
        if (!updated || updated.status !== "done") {
          throw new Error(
            `Terminal replay read-back failed for issue ${issue.id} on run ${input.runId}`,
          );
        }
      } catch (error) {
        if (isHttpConflict(error)) return { kind: "conflicted" } as const;
        throw error;
      }
      return { kind: "replayed" } as const;
    });

    for (const publication of activityPublications) publishActivity(publication);
    await executeIssuePostCommitActions(db, postCommitActions);
    return result;
  }

  return {
    finalizeTerminalRunDisposition,
    replayCommittedTerminalFinalization,
  };
}
