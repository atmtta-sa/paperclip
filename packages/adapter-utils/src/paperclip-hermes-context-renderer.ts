import { stablePaperclipHermesContextValue } from "./paperclip-hermes-context-normalization.js";
import type { PaperclipHermesContextV1 } from "./paperclip-hermes-context-types.js";

const CONTEXT_KINDS = new Set([
  "objective",
  "acceptance_criterion",
  "constraint",
  "directive",
  "evidence",
  "persona_ref",
  "repository_instructions_ref",
  "checkpoint_ref",
  "continuation_summary",
]);
const CONTEXT_AUTHORITIES = new Set(["authoritative", "verified", "untrusted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasStringFields(value: unknown, fields: string[]): boolean {
  return isRecord(value) && fields.every((field) => typeof value[field] === "string");
}

export function assertPaperclipHermesContextV1(
  value: unknown,
): asserts value is PaperclipHermesContextV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !hasStringFields(value.identity, ["companyId", "agentId", "issueId", "workspaceId", "runId"]) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("paperclip_hermes_context_invalid");
  }
  const keys = new Set<string>();
  const singletonKinds = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.kind !== "string" || !CONTEXT_KINDS.has(entry.kind) ||
      typeof entry.key !== "string" || !entry.key ||
      typeof entry.authority !== "string" || !CONTEXT_AUTHORITIES.has(entry.authority) ||
      typeof entry.precedence !== "number" || !Number.isFinite(entry.precedence) ||
      typeof entry.revision !== "number" || !Number.isFinite(entry.revision) ||
      !Array.isArray(entry.sources) ||
      entry.sources.length === 0 ||
      !entry.sources.every((source) => hasStringFields(source, ["type", "id"]))
    ) {
      throw new Error("paperclip_hermes_context_invalid");
    }
    if (keys.has(entry.key)) {
      throw new Error(`paperclip_hermes_context_duplicate_key:${entry.key}`);
    }
    keys.add(entry.key);
    if (entry.kind === "objective" || entry.kind === "directive") {
      if (singletonKinds.has(entry.kind)) {
        throw new Error(`paperclip_hermes_context_duplicate_kind:${entry.kind}`);
      }
      singletonKinds.add(entry.kind);
    }
  }
}

function renderValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(stablePaperclipHermesContextValue(value), null, 2);
}

export function renderPaperclipHermesContext(
  context: PaperclipHermesContextV1,
): string {
  assertPaperclipHermesContextV1(context);
  const identity = context.identity;
  const lines = [
    "# Paperclip structured context v1",
    "",
    "Identity references:",
    `- company_id: ${identity.companyId}`,
    `- agent_id: ${identity.agentId}`,
    `- issue_id: ${identity.issueId}`,
    `- workspace_id: ${identity.workspaceId}`,
    `- run_id: ${identity.runId}`,
  ];
  for (const entry of context.entries) {
    lines.push(
      "",
      `## ${entry.kind}: ${entry.key}`,
      renderValue(entry.value),
      `Provenance: ${entry.sources.map((source) => `${source.type}:${source.id}`).join(", ")}`,
    );
  }
  return lines.join("\n");
}
