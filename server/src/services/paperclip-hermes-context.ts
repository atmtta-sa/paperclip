import {
  buildPaperclipHermesContext,
  type PaperclipHermesContextV1,
} from "@paperclipai/adapter-utils/paperclip-hermes-context";

export const STANDARD_STRUCTURED_DIRECTIVE =
  "Execute only the assigned issue scope. Respect current approval, budget, and work-mode boundaries.";
export const PLANNING_STRUCTURED_DIRECTIVE =
  "Make the plan only. Do not write code or perform implementation work.";
export const ACCEPTED_PLAN_STRUCTURED_DIRECTIVE =
  "Create child issues from the approved plan only. Do not write code or perform implementation work on the planning issue.";

export interface HeartbeatHermesContextInput {
  companyId: string;
  agentId: string;
  runId: string;
  issue: {
    id: string;
    title: string;
    description: string | null;
    workMode: string | null;
    projectWorkspaceId: string | null;
    executionWorkspaceId: string | null;
  };
  wakeReason: string | null;
  wakeEventId: string | null;
  wakeComment: { id: string; body: string } | null;
  interactionStatus: string | null;
  continuationSummary: { id: string; body: string } | null;
  executionContinuation: {
    taskStateCapsule?: {
      hash: string;
      objective: string;
      stateFingerprint: string;
      nextAction: string;
    };
  } | null;
}

function directiveFor(input: HeartbeatHermesContextInput): {
  value: string;
  revision: number;
} {
  if (input.issue.workMode !== "planning") {
    return { value: STANDARD_STRUCTURED_DIRECTIVE, revision: 1 };
  }
  if (input.interactionStatus === "accepted") {
    return { value: ACCEPTED_PLAN_STRUCTURED_DIRECTIVE, revision: 2 };
  }
  return { value: PLANNING_STRUCTURED_DIRECTIVE, revision: 1 };
}

export function buildHeartbeatHermesContext(
  input: HeartbeatHermesContextInput,
): PaperclipHermesContextV1 {
  const directive = directiveFor(input);
  const capsule = input.executionContinuation?.taskStateCapsule;
  return buildPaperclipHermesContext({
    identity: {
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issue.id,
      workspaceId:
        input.issue.executionWorkspaceId ?? input.issue.projectWorkspaceId ?? "",
      runId: input.runId,
    },
    issue: {
      id: input.issue.id,
      title: input.issue.title,
      description: input.issue.description,
    },
    directive: {
      key: "directive.current",
      value: directive.value,
      revision: directive.revision,
      source: {
        type: "wake_event",
        id: input.wakeEventId ?? `${input.wakeReason ?? "wake"}:${input.runId}`,
      },
    },
    comments: input.wakeComment ? [input.wakeComment] : [],
    continuationSummary: input.continuationSummary,
    checkpoint: capsule
      ? {
          id: capsule.hash,
          objective: capsule.objective,
          stateFingerprint: capsule.stateFingerprint,
          nextAction: capsule.nextAction,
        }
      : null,
  });
}

export function installHeartbeatHermesContext(
  context: Record<string, unknown>,
  input: HeartbeatHermesContextInput,
): PaperclipHermesContextV1 {
  const structured = buildHeartbeatHermesContext(input);
  context.paperclipHermesContext = structured;
  return structured;
}
