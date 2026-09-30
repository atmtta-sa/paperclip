import { createHash } from "node:crypto";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_COMPLETED_WORK_CHARS = 8_000;
const MAX_REFERENCES = 64;

function clip(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type TaskStateCapsule = NonNullable<
  ExecutionContinuationEnvelope["taskStateCapsule"]
>;

export function buildTaskStateCapsule(input: {
  issueId: string;
  objective: string;
  completedWork: string | null;
  completedActions: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
  }>;
  unresolvedInteractionIds: string[];
  stateFingerprint: string;
}): TaskStateCapsule {
  // Multiline issue descriptions are safe; recognizable pasted chat and credentials are not.
  if (/slack transcript|authorization:\s*bearer|xox[baprs]-|sk-[A-Za-z0-9]{16,}|-----BEGIN .* PRIVATE KEY-----/i.test(input.objective)) {
    throw new Error("continuation_capsule_unsafe_objective");
  }
  const payload = {
    version: 1 as const,
    issueId: input.issueId,
    objective: clip(input.objective, MAX_OBJECTIVE_CHARS) ?? "",
    completedWork: clip(input.completedWork, MAX_COMPLETED_WORK_CHARS),
    nextAction: "Read the current issue and perform one authorized next action; stop if blocked.",
    completedActionRefs: input.completedActions
      .slice(-MAX_REFERENCES)
      .map((action) => ({
        runId: action.runId,
        receiptId: action.receiptId,
        operationId: action.operationId,
      })),
    blockers: [...new Set(input.unresolvedInteractionIds)]
      .sort()
      .slice(0, MAX_REFERENCES)
      .map((id) => ({ kind: "interaction" as const, id })),
    artifactRefs: input.completedActions
      .slice(-MAX_REFERENCES)
      .map((action) => `run:${action.runId}/receipt:${action.receiptId}`),
    stateFingerprint: input.stateFingerprint,
  };
  const hashPayload = {
    version: payload.version,
    issueId: payload.issueId,
    objective: payload.objective,
    nextAction: payload.nextAction,
    completedActionRefs: payload.completedActionRefs,
    blockers: payload.blockers,
    artifactRefs: payload.artifactRefs,
    stateFingerprint: payload.stateFingerprint,
  };
  return {
    ...payload,
    hash: createHash("sha256")
      .update(stableStringify(hashPayload))
      .digest("hex"),
  };
}

export function assertTaskStateCapsuleAdvanced(
  capsule: TaskStateCapsule,
  priorHash: string | null | undefined,
): void {
  if (priorHash && priorHash === capsule.hash) {
    throw new Error("continuation_capsule_unchanged");
  }
}
