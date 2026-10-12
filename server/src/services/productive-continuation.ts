import { and, eq, or } from "drizzle-orm";
import { automaticSuccessorIntents, type Db } from "@paperclipai/db";

type ProductiveContinuationBinding = {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  workspaceId: string | null;
};

type ProductiveRunDisposition = {
  version: 1 | 2;
  kind: "continue_same_issue";
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  workspaceId: string;
  nextAction: string;
  checkpoint: {
    kind: "run_workspace";
    runId: string;
    workspaceId: string;
  };
};

export const TERMINAL_RUN_DISPOSITION_KINDS = [
  "complete",
  "blocked",
  "needs_human",
  "in_review",
  "cancelled",
] as const;
export type TerminalRunDispositionKind =
  (typeof TERMINAL_RUN_DISPOSITION_KINDS)[number];

/**
 * Version-2 normalized disposition: the adapter injects the trusted runtime
 * binding from execution context and discards any model-supplied identity, so
 * every field here is authoritative once it matches the server's own binding.
 */
export type BoundRunDisposition = {
  version: 2;
  kind: TerminalRunDispositionKind;
  companyId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  workspaceId: string | null;
};

export type ProductiveRunDispositionDecision =
  | { kind: "legacy_missing" }
  | { kind: "continue_same_issue"; disposition: ProductiveRunDisposition }
  | { kind: "no_successor"; dispositionKind: string }
  | {
      kind: "terminal";
      dispositionKind: TerminalRunDispositionKind;
      disposition: BoundRunDisposition;
    }
  | {
      kind: "denied";
      reason:
        | "unsupported_disposition"
        | "disposition_invalid"
        | "authorization_binding_mismatch"
        | "checkpoint_invalid"
        | "next_action_invalid";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

export function parseProductiveRunDisposition(
  resultJson: unknown,
  binding: ProductiveContinuationBinding,
): ProductiveRunDispositionDecision {
  const result = record(resultJson);
  if (!result || result.runDisposition == null) return { kind: "legacy_missing" };

  const raw = record(result.runDisposition);
  if (!raw) return { kind: "denied", reason: "disposition_invalid" };
  if (raw.version !== 1 && raw.version !== 2) {
    return { kind: "denied", reason: "unsupported_disposition" };
  }

  if (
    typeof raw.kind !== "string" ||
    ![
      "complete",
      "continue_same_issue",
      "blocked",
      "needs_human",
      "in_review",
      "cancelled",
    ].includes(raw.kind)
  ) {
    return { kind: "denied", reason: "disposition_invalid" };
  }

  // Version 1 is the legacy adapter contract: terminal kinds carried no
  // binding and only confirm a state the issue already reached. Version 2
  // dispositions are fully bound by the adapter and must match the server's
  // trusted execution binding exactly before they decide anything.
  if (raw.version === 1 && raw.kind !== "continue_same_issue") {
    return { kind: "no_successor", dispositionKind: raw.kind };
  }

  if (
    raw.companyId !== binding.companyId ||
    raw.issueId !== binding.issueId ||
    raw.agentId !== binding.agentId ||
    raw.runId !== binding.runId ||
    (raw.workspaceId ?? null) !== (binding.workspaceId ?? null)
  ) {
    return { kind: "denied", reason: "authorization_binding_mismatch" };
  }

  if (
    raw.version === 2 &&
    (TERMINAL_RUN_DISPOSITION_KINDS as readonly string[]).includes(raw.kind)
  ) {
    return {
      kind: "terminal",
      dispositionKind: raw.kind as TerminalRunDispositionKind,
      // The returned disposition is rebuilt from the trusted binding, never
      // from the parsed payload.
      disposition: {
        version: 2,
        kind: raw.kind as TerminalRunDispositionKind,
        companyId: binding.companyId,
        issueId: binding.issueId,
        agentId: binding.agentId,
        runId: binding.runId,
        workspaceId: binding.workspaceId ?? null,
      },
    };
  }
  if (raw.kind !== "continue_same_issue") {
    return { kind: "denied", reason: "disposition_invalid" };
  }

  // Continuation requires a workspace checkpoint; a workspaceless binding can
  // never authorize one, regardless of what the payload claims.
  if (!binding.workspaceId) {
    return { kind: "denied", reason: "authorization_binding_mismatch" };
  }

  const nextAction = boundedText(raw.nextAction, 2_000);
  if (!nextAction) return { kind: "denied", reason: "next_action_invalid" };

  const checkpoint = record(raw.checkpoint);
  if (
    !checkpoint ||
    checkpoint.kind !== "run_workspace" ||
    checkpoint.runId !== binding.runId ||
    checkpoint.workspaceId !== binding.workspaceId
  ) {
    return { kind: "denied", reason: "checkpoint_invalid" };
  }

  return {
    kind: "continue_same_issue",
    disposition: {
      version: raw.version,
      kind: "continue_same_issue",
      companyId: binding.companyId,
      issueId: binding.issueId,
      agentId: binding.agentId,
      runId: binding.runId,
      workspaceId: binding.workspaceId,
      nextAction,
      checkpoint: {
        kind: "run_workspace",
        runId: binding.runId,
        workspaceId: binding.workspaceId,
      },
    },
  };
}

export function predecessorProductiveContinuationAuthorityAllows(
  run: { status: string; errorCode?: string | null; resultJson?: unknown },
  binding: ProductiveContinuationBinding,
): boolean {
  if (run.status !== "succeeded" || run.errorCode != null) return false;
  return parseProductiveRunDisposition(run.resultJson, binding).kind ===
    "continue_same_issue";
}

export function productiveContinuationBindingFromRuns(
  predecessor: {
    id: string;
    companyId: string;
    agentId: string;
    contextSnapshot?: unknown;
  },
  successor: { contextSnapshot?: unknown },
  issueId: string,
): ProductiveContinuationBinding | null {
  const successorContext = record(successor.contextSnapshot);
  if (
    successorContext?.productiveContinuation !== true ||
    boundedText(successorContext.automaticSuccessorIntentId, 100) === null ||
    successorContext.issueId !== issueId
  ) {
    return null;
  }
  const predecessorContext = record(predecessor.contextSnapshot);
  const workspace = record(predecessorContext?.paperclipWorkspace);
  const workspaceId = boundedText(workspace?.workspaceId, 100);
  if (!workspaceId || predecessorContext?.issueId !== issueId) return null;
  return {
    companyId: predecessor.companyId,
    issueId,
    agentId: predecessor.agentId,
    runId: predecessor.id,
    workspaceId,
  };
}

type AutomaticSuccessorIntentInput = {
  companyId: string;
  issueId: string;
  agentId: string;
  predecessorRunId: string;
  chainRootRunId: string;
  kind: "productive" | "corrective" | "recovery" | "terminal";
  status?: "pending" | "materialized" | "denied" | "cancelled";
  checkpointRef?: string | null;
  nextAction?: string | null;
  authorizationBinding: Record<string, unknown>;
  policyVersion: number;
  budgetSnapshot?: Record<string, unknown> | null;
  reason: string;
  denialReason?: string | null;
};

export function buildAutomaticSuccessorWakeIdempotencyKey(intentId: string): string {
  return `automatic-successor:${intentId}`;
}

export function decideProductiveRecoveryIntent(
  intent: Pick<typeof automaticSuccessorIntents.$inferSelect, "kind" | "status"> | null,
): { kind: "materialize" } | { kind: "skip" } {
  return intent?.kind === "productive" && intent.status === "pending"
    ? { kind: "materialize" }
    : { kind: "skip" };
}

export async function settleAutomaticSuccessorIntent(
  db: Db,
  input:
    | {
        intentId: string;
        outcome: "materialized";
        wakeupRequestId: string | null;
        successorRunId: string;
      }
    | {
        intentId: string;
        outcome: "denied";
        denialReason: string;
      },
) {
  const now = new Date();
  if (input.outcome === "materialized") {
    await db
      .update(automaticSuccessorIntents)
      .set({
        status: "materialized",
        denialReason: null,
        wakeupRequestId: input.wakeupRequestId,
        successorRunId: input.successorRunId,
        updatedAt: now,
      })
      .where(
        and(
          eq(automaticSuccessorIntents.id, input.intentId),
          or(
            eq(automaticSuccessorIntents.status, "pending"),
            and(
              eq(automaticSuccessorIntents.status, "denied"),
              eq(
                automaticSuccessorIntents.denialReason,
                "materialization_denied",
              ),
            ),
          ),
        ),
      );
  } else {
    await db
      .update(automaticSuccessorIntents)
      .set({
        status: "denied",
        denialReason: input.denialReason,
        updatedAt: now,
      })
      .where(
        and(
          eq(automaticSuccessorIntents.id, input.intentId),
          eq(automaticSuccessorIntents.status, "pending"),
        ),
      );
  }
  return db
    .select()
    .from(automaticSuccessorIntents)
    .where(eq(automaticSuccessorIntents.id, input.intentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function claimAutomaticSuccessorIntent(
  db: Db,
  input: AutomaticSuccessorIntentInput,
) {
  const [created] = await db
    .insert(automaticSuccessorIntents)
    .values(input)
    .onConflictDoNothing({
      target: [
        automaticSuccessorIntents.companyId,
        automaticSuccessorIntents.predecessorRunId,
      ],
    })
    .returning();

  if (created) return { intent: created, created: true };

  const [existing] = await db
    .select()
    .from(automaticSuccessorIntents)
    .where(
      and(
        eq(automaticSuccessorIntents.companyId, input.companyId),
        eq(automaticSuccessorIntents.predecessorRunId, input.predecessorRunId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Automatic successor intent conflict could not be read");
  return { intent: existing, created: false };
}
