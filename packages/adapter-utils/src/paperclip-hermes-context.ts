import type {
  BuildPaperclipHermesContextInput,
  PaperclipHermesContextCandidate,
  PaperclipHermesContextEntry,
  PaperclipHermesContextInput,
  PaperclipHermesContextSource,
  PaperclipHermesContextV1,
  PaperclipHermesIssueInput,
} from "./paperclip-hermes-context-types.js";
import {
  paperclipHermesContextValueFingerprint as normalizedValue,
} from "./paperclip-hermes-context-normalization.js";

export type {
  BuildPaperclipHermesContextInput,
  PaperclipHermesContextAuthority,
  PaperclipHermesContextCandidate,
  PaperclipHermesContextEntry,
  PaperclipHermesContextIdentity,
  PaperclipHermesContextInput,
  PaperclipHermesContextKind,
  PaperclipHermesContextSource,
  PaperclipHermesContextV1,
} from "./paperclip-hermes-context-types.js";

export class PaperclipHermesContextConflictError extends Error {
  readonly code = "paperclip_hermes_context_conflict";

  constructor(
    readonly key: string,
    readonly sourceIds: string[],
  ) {
    super(`${PaperclipHermesContextConflictError.name}: ${key} (${sourceIds.join(", ")})`);
    this.name = PaperclipHermesContextConflictError.name;
  }
}

function sourceOrder(
  left: PaperclipHermesContextSource,
  right: PaperclipHermesContextSource,
): number {
  return left.id.localeCompare(right.id) || left.type.localeCompare(right.type);
}

function candidateOrder(
  left: PaperclipHermesContextCandidate,
  right: PaperclipHermesContextCandidate,
): number {
  return (
    right.precedence - left.precedence ||
    right.revision - left.revision ||
    sourceOrder(left.source, right.source)
  );
}

function uniqueSources(
  candidates: PaperclipHermesContextCandidate[],
): PaperclipHermesContextSource[] {
  const sources = new Map<string, PaperclipHermesContextSource>();
  for (const candidate of candidates) {
    sources.set(`${candidate.source.type}\u0000${candidate.source.id}`, candidate.source);
  }
  return [...sources.values()].sort(sourceOrder);
}

function conflict(
  key: string,
  candidates: PaperclipHermesContextCandidate[],
): never {
  throw new PaperclipHermesContextConflictError(
    key,
    [...new Set(candidates.map((candidate) => candidate.source.id))].sort(),
  );
}

function canonicalEntry(
  key: string,
  candidates: PaperclipHermesContextCandidate[],
): PaperclipHermesContextEntry {
  const ranked = [...candidates].sort(candidateOrder);
  const winner = ranked[0];
  if (!winner) throw new Error(`paperclip_hermes_context_empty_key: ${key}`);
  const topRank = ranked.filter(
    (candidate) =>
      candidate.precedence === winner.precedence &&
      candidate.revision === winner.revision,
  );
  if (new Set(topRank.map((candidate) => normalizedValue(candidate.value))).size > 1) {
    conflict(key, topRank);
  }
  const winnerValue = normalizedValue(winner.value);
  return {
    kind: winner.kind,
    key,
    value: winner.value,
    authority: winner.authority,
    precedence: winner.precedence,
    revision: winner.revision,
    sources: uniqueSources(
      ranked.filter((candidate) => normalizedValue(candidate.value) === winnerValue),
    ),
  };
}

function assertSingletonKind(
  entries: PaperclipHermesContextEntry[],
  kind: "objective" | "directive",
): void {
  const matching = entries.filter((entry) => entry.kind === kind);
  if (matching.length > 1) {
    throw new PaperclipHermesContextConflictError(
      `${kind}.current`,
      matching.flatMap((entry) => entry.sources.map((source) => source.id)).sort(),
    );
  }
}

export function canonicalizePaperclipHermesContext(
  input: PaperclipHermesContextInput,
): PaperclipHermesContextV1 {
  const grouped = new Map<string, PaperclipHermesContextCandidate[]>();
  for (const candidate of input.candidates) {
    if (candidate.kind === "directive" && candidate.authority !== "authoritative") {
      continue;
    }
    const existing = grouped.get(candidate.key) ?? [];
    existing.push(candidate);
    grouped.set(candidate.key, existing);
  }
  const entries = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidates]) => canonicalEntry(key, candidates));
  assertSingletonKind(entries, "objective");
  assertSingletonKind(entries, "directive");
  return { version: 1, identity: { ...input.identity }, entries };
}

function objectiveCandidate(
  issue: PaperclipHermesIssueInput | null | undefined,
  sourceType: string,
): PaperclipHermesContextCandidate | null {
  if (!issue) return null;
  const value = issue.description?.trim() ? issue.description : issue.title;
  if (!value.trim()) return null;
  return {
    kind: "objective",
    key: "objective.current",
    value,
    authority: "authoritative",
    precedence: 100,
    revision: 1,
    source: { type: sourceType, id: issue.id },
  };
}

export function buildPaperclipHermesContext(
  input: BuildPaperclipHermesContextInput,
): PaperclipHermesContextV1 {
  const candidates: PaperclipHermesContextCandidate[] = [];
  const issueObjective = objectiveCandidate(input.issue, "issue");
  const wakeObjective = objectiveCandidate(input.wakeIssue, "wake_issue");
  if (issueObjective) candidates.push(issueObjective);
  if (wakeObjective) candidates.push(wakeObjective);
  if (input.checkpoint?.objective?.trim()) {
    candidates.push({
      kind: "objective",
      key: "objective.current",
      value: input.checkpoint.objective,
      authority: "verified",
      precedence: 50,
      revision: 1,
      source: { type: "checkpoint", id: input.checkpoint.id },
    });
  }
  const objectiveValues = new Set(
    candidates
      .filter((candidate) => candidate.kind === "objective")
      .map((candidate) => normalizedValue(candidate.value)),
  );
  if (input.directive?.value.trim()) {
    candidates.push({
      kind: "directive",
      key: input.directive.key,
      value: input.directive.value,
      authority: "authoritative",
      precedence: 100,
      revision: input.directive.revision,
      source: input.directive.source,
    });
  }
  for (const comment of input.comments ?? []) {
    if (!comment.id || !comment.body.trim()) continue;
    if (objectiveValues.has(normalizedValue(comment.body))) continue;
    candidates.push({
      kind: "evidence",
      key: `evidence.comment.${comment.id}`,
      value: comment.body,
      authority: "untrusted",
      precedence: 10,
      revision: 1,
      source: { type: "comment", id: comment.id },
    });
  }
  if (
    input.continuationSummary?.body.trim() &&
    !objectiveValues.has(normalizedValue(input.continuationSummary.body))
  ) {
    candidates.push({
      kind: "continuation_summary",
      key: "continuation.current",
      value: input.continuationSummary.body,
      authority: "verified",
      precedence: 50,
      revision: 1,
      source: { type: "summary", id: input.continuationSummary.id },
    });
  }
  if (input.checkpoint) {
    candidates.push({
      kind: "checkpoint_ref",
      key: "continuation.current",
      value: {
        id: input.checkpoint.id,
        stateFingerprint: input.checkpoint.stateFingerprint,
        nextAction: input.checkpoint.nextAction ?? null,
      },
      authority: "verified",
      precedence: 100,
      revision: 1,
      source: { type: "checkpoint", id: input.checkpoint.id },
    });
  }
  return canonicalizePaperclipHermesContext({ identity: input.identity, candidates });
}

export {
  assertPaperclipHermesContextV1,
  renderPaperclipHermesContext,
} from "./paperclip-hermes-context-renderer.js";
