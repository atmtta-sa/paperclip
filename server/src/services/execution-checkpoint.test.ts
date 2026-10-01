import { describe, expect, it } from "vitest";
import { parseExecutionCheckpoint } from "./execution-checkpoint.js";

const VALID_CHECKPOINT = {
  version: 1,
  workspace: {
    cwd: "/workspace/project",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    branch: "feat/checkpoint",
    statusSha256: "a".repeat(64),
  },
  patch: {
    kind: "git_diff",
    sha256: "b".repeat(64),
    bytes: 128,
  },
  tests: {
    status: "passed",
    commands: [{ command: "pnpm test", exitCode: 0 }],
  },
  blockers: {
    status: "clear",
    evidence: ["No unresolved issue dependency"],
  },
  nextAction: "Run the focused typecheck.",
};

describe("execution checkpoint", () => {
  it("accepts complete durable checkpoint evidence", () => {
    expect(parseExecutionCheckpoint(VALID_CHECKPOINT)).toEqual(VALID_CHECKPOINT);
  });

  it("accepts an explicit not-run test state without invented commands", () => {
    expect(
      parseExecutionCheckpoint({
        ...VALID_CHECKPOINT,
        tests: { status: "not_run", commands: [] },
      }),
    ).not.toBeNull();
  });

  it.each([
    undefined,
    { ...VALID_CHECKPOINT, nextAction: "" },
    { ...VALID_CHECKPOINT, workspace: { ...VALID_CHECKPOINT.workspace, statusSha256: "short" } },
    { ...VALID_CHECKPOINT, patch: { ...VALID_CHECKPOINT.patch, bytes: -1 } },
    { ...VALID_CHECKPOINT, tests: { status: "passed", commands: [] } },
    {
      ...VALID_CHECKPOINT,
      tests: { status: "not_run", commands: [{ command: "pnpm test", exitCode: 0 }] },
    },
    {
      ...VALID_CHECKPOINT,
      tests: { status: "passed", commands: [{ command: "pnpm test", exitCode: 1 }] },
    },
    {
      ...VALID_CHECKPOINT,
      tests: { status: "failed", commands: [{ command: "pnpm test", exitCode: 0 }] },
    },
    { ...VALID_CHECKPOINT, blockers: { status: "blocked", evidence: [] } },
  ])("rejects incomplete or malformed durable evidence", (checkpoint) => {
    expect(parseExecutionCheckpoint(checkpoint)).toBeNull();
  });
});
