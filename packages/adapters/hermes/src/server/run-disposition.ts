const OPEN = "<paperclip-run-disposition>";
const CLOSE = "</paperclip-run-disposition>";
const MAX_ENVELOPE_LENGTH = 4_000;
const MAX_NEXT_ACTION_LENGTH = 2_000;
const MAX_CHECKPOINT_ITEMS = 16;
const MAX_CHECKPOINT_ITEM_LENGTH = 500;
const MAX_VERIFICATION_SUMMARY_LENGTH = 2_000;
const MAX_CHECKPOINT_JSON_LENGTH = 4_000;
const TERMINAL_KINDS = new Set([
  "complete",
  "blocked",
  "needs_human",
  "in_review",
  "cancelled",
]);

export const PAPERCLIP_RUN_DISPOSITION_INSTRUCTION = [
  "## Paperclip run disposition",
  "At the very end of your final response, emit exactly one disposition envelope after all human-readable text:",
  `${OPEN}{"version":1,"kind":"complete"}${CLOSE}`,
  "Allowed kinds: complete, continue_same_issue, blocked, needs_human, in_review, cancelled.",
  `Use continue_same_issue only for authorized unfinished work that made durable progress. Include a bounded nextAction and completionCheckpoint: ${OPEN}{"version":1,"kind":"continue_same_issue","nextAction":"one concrete next action","completionCheckpoint":{"version":1,"completedItems":["bounded completed item"],"remainingAcceptanceItems":["bounded remaining item"],"verificationSummary":"bounded verified result"}}${CLOSE}`,
  "Do not list Paperclip status, comment, or read-back bookkeeping as remaining acceptance work; the control plane owns that finalization transition.",
  "When implementation and acceptance verification are complete, remainingAcceptanceItems must be empty so the next bounded run is finalization-only.",
  "Do not add identity fields; the runtime binds the proposal to the current run and workspace.",
].join("\n");

type Binding = {
  companyId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  workspaceId: string | null;
};

export function paperclipRunDispositionBinding(ctx: {
  runId: string;
  agent: { id: string; companyId: string };
  context?: Record<string, unknown>;
}): Binding {
  const context = record(ctx.context) ?? {};
  const structuredIdentity = record(record(context.paperclipHermesContext)?.identity);
  const workspace = record(context.paperclipWorkspace);
  return {
    companyId: ctx.agent.companyId,
    issueId: boundedText(context.issueId, 100) ??
      boundedText(context.taskId, 100) ??
      boundedText(structuredIdentity?.issueId, 100),
    agentId: ctx.agent.id,
    runId: ctx.runId,
    workspaceId: boundedText(workspace?.workspaceId, 100) ??
      boundedText(structuredIdentity?.workspaceId, 100),
  };
}

export type CompletionCheckpoint = {
  version: 1;
  completedItems: string[];
  remainingAcceptanceItems: string[];
  verificationSummary?: string;
};

// The model's wire envelope stays version 1. The adapter normalizes every
// accepted disposition to version 2: the trusted runtime binding (company,
// issue, agent, run, workspace) is injected here, from execution context, and
// any identity fields the model emitted are discarded. Version 2 is the
// normalized contract the server validates; it never appears on the wire.
type RunDisposition =
  | {
      version: 2;
      kind: "complete" | "blocked" | "needs_human" | "in_review" | "cancelled";
      companyId: string;
      issueId: string | null;
      agentId: string;
      runId: string;
      workspaceId: string | null;
    }
  | {
      version: 2;
      kind: "continue_same_issue";
      companyId: string;
      issueId: string;
      agentId: string;
      runId: string;
      workspaceId: string;
      nextAction: string;
      completionCheckpoint?: CompletionCheckpoint;
      checkpoint: {
        kind: "run_workspace";
        runId: string;
        workspaceId: string;
      };
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function boundedTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CHECKPOINT_ITEMS) return null;
  const items = value.map((item) => boundedText(item, MAX_CHECKPOINT_ITEM_LENGTH));
  return items.every((item): item is string => item !== null) ? items : null;
}

export function parseCompletionCheckpoint(value: unknown): CompletionCheckpoint | null {
  const raw = record(value);
  if (!raw || raw.version !== 1) return null;
  const completedItems = boundedTextArray(raw.completedItems);
  const remainingAcceptanceItems = boundedTextArray(raw.remainingAcceptanceItems);
  if (!completedItems || !remainingAcceptanceItems) return null;
  const verificationSummary = raw.verificationSummary === undefined
    ? undefined
    : boundedText(raw.verificationSummary, MAX_VERIFICATION_SUMMARY_LENGTH);
  if (raw.verificationSummary !== undefined && !verificationSummary) return null;
  const checkpoint: CompletionCheckpoint = {
    version: 1,
    completedItems,
    remainingAcceptanceItems,
    ...(verificationSummary ? { verificationSummary } : {}),
  };
  return Buffer.byteLength(JSON.stringify(checkpoint), "utf8") <= MAX_CHECKPOINT_JSON_LENGTH
    ? checkpoint
    : null;
}

export function extractPaperclipRunDisposition(
  output: string,
  binding: Binding,
): RunDisposition | null {
  const trimmed = output.trimEnd();
  if (!trimmed.endsWith(CLOSE)) return null;
  const openIndex = trimmed.lastIndexOf(OPEN);
  if (openIndex < 0) return null;
  const jsonStart = openIndex + OPEN.length;
  const jsonText = trimmed.slice(jsonStart, -CLOSE.length);
  if (jsonText.length === 0 || jsonText.length > MAX_ENVELOPE_LENGTH) return null;
  if (trimmed.slice(0, openIndex).includes(OPEN)) return null;

  let raw: Record<string, unknown> | null = null;
  try {
    raw = record(JSON.parse(jsonText));
  } catch {
    return null;
  }
  if (!raw || raw.version !== 1 || typeof raw.kind !== "string") return null;

  if (TERMINAL_KINDS.has(raw.kind)) {
    return {
      version: 2,
      kind: raw.kind as "complete" | "blocked" | "needs_human" | "in_review" | "cancelled",
      companyId: binding.companyId,
      issueId: binding.issueId,
      agentId: binding.agentId,
      runId: binding.runId,
      workspaceId: binding.workspaceId,
    };
  }
  if (raw.kind !== "continue_same_issue") return null;

  const nextAction = boundedText(raw.nextAction, MAX_NEXT_ACTION_LENGTH);
  const parsedCheckpoint = raw.completionCheckpoint === undefined
    ? undefined
    : parseCompletionCheckpoint(raw.completionCheckpoint);
  const issueId = boundedText(binding.issueId, 100);
  const workspaceId = boundedText(binding.workspaceId, 100);
  if (
    !nextAction ||
    !issueId ||
    !workspaceId ||
    raw.completionCheckpoint !== undefined && !parsedCheckpoint
  ) return null;

  return {
    version: 2,
    kind: "continue_same_issue",
    companyId: binding.companyId,
    issueId,
    agentId: binding.agentId,
    runId: binding.runId,
    workspaceId,
    nextAction,
    ...(parsedCheckpoint ? { completionCheckpoint: parsedCheckpoint } : {}),
    checkpoint: {
      kind: "run_workspace",
      runId: binding.runId,
      workspaceId,
    },
  };
}
