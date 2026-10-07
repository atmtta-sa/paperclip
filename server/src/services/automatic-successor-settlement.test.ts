import { describe, expect, it } from "vitest";
import { predecessorRetryAuthorityAllows } from "./automatic-successor-settlement.js";

const validExecutionCheckpoint = () => ({
  version: 1 as const,
  workspace: {
    cwd: "/workspace/project",
    gitHead: "a".repeat(40),
    branch: "fix/rollover",
    statusSha256: "b".repeat(64),
  },
  patch: { kind: "git_diff" as const, sha256: "c".repeat(64), bytes: 128 },
  tests: { status: "not_run" as const, commands: [] },
  blockers: { status: "clear" as const, evidence: ["Managed rollover boundary"] },
  nextAction: "Continue the current issue from the durable workspace.",
});

describe("predecessorRetryAuthorityAllows", () => {
  it.each([
    {
      errorCode: "session_rollover_required",
      resultJson: { executionCheckpoint: validExecutionCheckpoint() },
    },
    {
      errorCode: null,
      resultJson: {
        turn_exit_reason: "session_rollover_required",
        executionCheckpoint: validExecutionCheckpoint(),
      },
    },
  ])("accepts a session rollover only with a valid execution checkpoint", (run) => {
    expect(predecessorRetryAuthorityAllows(run as never)).toBe(true);
  });

  it("keeps conversation continuation authority for non-rollover runs", () => {
    expect(predecessorRetryAuthorityAllows({
      errorCode: null,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    } as never)).toBe(true);
  });

  it.each([
    { errorCode: "session_rollover_required", resultJson: {} },
    {
      errorCode: "session_rollover_required",
      resultJson: { executionCheckpoint: { version: 1 } },
    },
    {
      errorCode: "overloaded",
      resultJson: { executionCheckpoint: validExecutionCheckpoint() },
    },
    {
      errorCode: "session_rollover_required",
      resultJson: {
        executionCheckpoint: {
          ...validExecutionCheckpoint(),
          blockers: { status: "blocked", evidence: ["Unresolved dependency"] },
        },
      },
    },
    {
      errorCode: "overloaded",
      resultJson: {
        turn_exit_reason: "session_rollover_required",
        executionCheckpoint: validExecutionCheckpoint(),
      },
    },
    {
      errorCode: "session_rollover_required",
      resultJson: {
        turn_exit_reason: "overloaded",
        executionCheckpoint: validExecutionCheckpoint(),
      },
    },
    {
      errorCode: "session_rollover_required",
      resultJson: {
        conversationContinuation: "continue_conversation_v1",
        executionCheckpoint: {
          ...validExecutionCheckpoint(),
          blockers: { status: "blocked", evidence: ["Unresolved dependency"] },
        },
      },
    },
    {
      errorCode: "overloaded",
      resultJson: {
        conversationContinuation: "continue_conversation_v1",
        turn_exit_reason: "session_rollover_required",
        executionCheckpoint: validExecutionCheckpoint(),
      },
    },
  ])("rejects missing, invalid, blocked, unrelated, or contradictory rollover authority", (run) => {
    expect(predecessorRetryAuthorityAllows(run as never)).toBe(false);
  });
});
