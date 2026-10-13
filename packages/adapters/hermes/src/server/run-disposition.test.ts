import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_RUN_DISPOSITION_INSTRUCTION,
  extractPaperclipRunDisposition,
} from "./run-disposition.js";

const binding = {
  companyId: "company-1",
  issueId: "issue-1",
  agentId: "agent-1",
  runId: "run-1",
  workspaceId: "workspace-1",
};

function envelope(value: unknown): string {
  return `<paperclip-run-disposition>${JSON.stringify(value)}</paperclip-run-disposition>`;
}

describe("Hermes productive disposition transport", () => {
  it("binds a continuation proposal to authoritative run identity", () => {
    expect(
      extractPaperclipRunDisposition(
        `Work completed.\n${envelope({
          version: 1,
          kind: "continue_same_issue",
          nextAction: "Run the remaining integration test.",
        })}`,
        binding,
      ),
    ).toEqual({
      version: 2,
      kind: "continue_same_issue",
      ...binding,
      nextAction: "Run the remaining integration test.",
      checkpoint: {
        kind: "run_workspace",
        runId: "run-1",
        workspaceId: "workspace-1",
      },
    });
  });

  it("binds terminal dispositions to authoritative run identity", () => {
    expect(
      extractPaperclipRunDisposition(
        envelope({ version: 1, kind: "complete" }),
        binding,
      ),
    ).toEqual({ version: 2, kind: "complete", ...binding });
  });

  it("binds terminal dispositions for runs without an issue or workspace scope", () => {
    expect(
      extractPaperclipRunDisposition(
        envelope({ version: 1, kind: "blocked" }),
        { ...binding, issueId: null, workspaceId: null },
      ),
    ).toEqual({
      version: 2,
      kind: "blocked",
      ...binding,
      issueId: null,
      workspaceId: null,
    });
  });

  it("overrides model-supplied identity fields with the trusted binding", () => {
    expect(
      extractPaperclipRunDisposition(
        envelope({
          version: 1,
          kind: "complete",
          companyId: "company-2",
          issueId: "issue-2",
          agentId: "agent-2",
          runId: "run-2",
          workspaceId: "workspace-2",
        }),
        binding,
      ),
    ).toEqual({ version: 2, kind: "complete", ...binding });
    expect(
      extractPaperclipRunDisposition(
        envelope({
          version: 1,
          kind: "continue_same_issue",
          companyId: "company-2",
          issueId: "issue-2",
          agentId: "agent-2",
          runId: "run-2",
          workspaceId: "workspace-2",
          nextAction: "Run the remaining integration test.",
          checkpoint: {
            kind: "run_workspace",
            runId: "run-2",
            workspaceId: "workspace-2",
          },
        }),
        binding,
      ),
    ).toEqual({
      version: 2,
      kind: "continue_same_issue",
      ...binding,
      nextAction: "Run the remaining integration test.",
      checkpoint: {
        kind: "run_workspace",
        runId: "run-1",
        workspaceId: "workspace-1",
      },
    });
  });

  it.each([
    ["missing envelope", "ordinary final response", binding],
    ["malformed JSON", "<paperclip-run-disposition>{</paperclip-run-disposition>", binding],
    ["unsupported version", envelope({ version: 2, kind: "complete" }), binding],
    ["unknown kind", envelope({ version: 1, kind: "later" }), binding],
    ["missing next action", envelope({ version: 1, kind: "continue_same_issue" }), binding],
    ["missing workspace binding", envelope({ version: 1, kind: "continue_same_issue", nextAction: "Continue." }), { ...binding, workspaceId: null }],
    ["envelope not terminal", `${envelope({ version: 1, kind: "complete" })}\nmore text`, binding],
  ])("rejects %s", (_name, output, candidateBinding) => {
    expect(extractPaperclipRunDisposition(output, candidateBinding)).toBeNull();
  });

  it("instructs Hermes to emit only the bounded terminal envelope", () => {
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).toContain("<paperclip-run-disposition>");
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).toContain("continue_same_issue");
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).toContain("nextAction");
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).not.toContain("companyId");
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).not.toContain("workspaceId");
  });
});
