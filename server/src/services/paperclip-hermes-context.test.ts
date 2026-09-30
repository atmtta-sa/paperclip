import { describe, expect, it } from "vitest";

import {
  ACCEPTED_PLAN_STRUCTURED_DIRECTIVE,
  PLANNING_STRUCTURED_DIRECTIVE,
  STANDARD_STRUCTURED_DIRECTIVE,
  buildHeartbeatHermesContext,
  installHeartbeatHermesContext,
} from "./paperclip-hermes-context.js";

const baseInput = {
  companyId: "company-1",
  agentId: "agent-1",
  runId: "run-1",
  issue: {
    id: "issue-1",
    title: "Implement the renderer",
    description: "Use [REDACTED] and implement the scoped renderer.",
    workMode: "standard",
    projectWorkspaceId: "project-workspace-1",
    executionWorkspaceId: "execution-workspace-1",
  },
  wakeReason: "issue_assigned",
  wakeEventId: "wake-1",
  wakeComment: null,
  interactionStatus: null,
  continuationSummary: null,
  executionContinuation: null,
};

describe("buildHeartbeatHermesContext", () => {
  it("builds objective, identity, and server-owned standard directive from redacted fields", () => {
    const context = buildHeartbeatHermesContext(baseInput);

    expect(context.identity).toEqual({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      workspaceId: "execution-workspace-1",
      runId: "run-1",
    });
    expect(context.entries.find((entry) => entry.kind === "objective")?.value).toBe(
      "Use [REDACTED] and implement the scoped renderer.",
    );
    expect(context.entries.find((entry) => entry.kind === "directive")).toMatchObject({
      key: "directive.current",
      value: STANDARD_STRUCTURED_DIRECTIVE,
      sources: [{ type: "wake_event", id: "wake-1" }],
    });
  });

  it("uses the accepted-plan directive instead of the initial planning directive", () => {
    const initial = buildHeartbeatHermesContext({
      ...baseInput,
      issue: { ...baseInput.issue, workMode: "planning" },
    });
    const accepted = buildHeartbeatHermesContext({
      ...baseInput,
      issue: { ...baseInput.issue, workMode: "planning" },
      interactionStatus: "accepted",
    });

    expect(initial.entries.find((entry) => entry.kind === "directive")?.value).toBe(
      PLANNING_STRUCTURED_DIRECTIVE,
    );
    expect(accepted.entries.find((entry) => entry.kind === "directive")?.value).toBe(
      ACCEPTED_PLAN_STRUCTURED_DIRECTIVE,
    );
  });

  it("keeps a redacted wake comment as evidence and prefers checkpoint over summary", () => {
    const context = buildHeartbeatHermesContext({
      ...baseInput,
      wakeComment: { id: "comment-1", body: "Use [REDACTED] evidence." },
      continuationSummary: { id: "summary-1", body: "Old summary body." },
      executionContinuation: {
        taskStateCapsule: {
          hash: "capsule-1",
          objective: baseInput.issue.description,
          stateFingerprint: "state-1",
          nextAction: "Run the focused tests.",
        },
      },
    });

    expect(context.entries.find((entry) => entry.key === "evidence.comment.comment-1")?.value).toBe(
      "Use [REDACTED] evidence.",
    );
    const continuation = context.entries.filter((entry) => entry.key === "continuation.current");
    expect(continuation).toHaveLength(1);
    expect(continuation[0]?.kind).toBe("checkpoint_ref");
  });

  it("installs the canonical object into the run context without legacy projections", () => {
    const runContext: Record<string, unknown> = {
      paperclipTaskMarkdown: "legacy projection remains independently available",
    };

    const installed = installHeartbeatHermesContext(runContext, baseInput);

    expect(runContext.paperclipHermesContext).toBe(installed);
    expect(installed.version).toBe(1);
    expect(runContext.paperclipTaskMarkdown).toBe(
      "legacy projection remains independently available",
    );
  });
});
