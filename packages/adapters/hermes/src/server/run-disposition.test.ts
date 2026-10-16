import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_RUN_DISPOSITION_INSTRUCTION,
  extractPaperclipRunDisposition,
  parseCompletionCheckpoint,
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
  it("excludes final control-plane bookkeeping from remaining acceptance work", () => {
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).toContain(
      "Do not list Paperclip status, comment, or read-back bookkeeping as remaining acceptance work",
    );
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).toContain(
      "remainingAcceptanceItems must be empty",
    );
  });

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

  it("preserves a bounded completion checkpoint on a continuation", () => {
    expect(
      extractPaperclipRunDisposition(
        envelope({
          version: 1,
          kind: "continue_same_issue",
          nextAction: "Finalize the issue from verified evidence.",
          completionCheckpoint: {
            version: 1,
            completedItems: ["Implementation complete", "Focused tests passed"],
            remainingAcceptanceItems: [],
            verificationSummary: "5 frontend and 19 architecture tests passed.",
          },
        }),
        binding,
      ),
    ).toMatchObject({
      kind: "continue_same_issue",
      completionCheckpoint: {
        version: 1,
        completedItems: ["Implementation complete", "Focused tests passed"],
        remainingAcceptanceItems: [],
        verificationSummary: "5 frontend and 19 architecture tests passed.",
      },
    });
  });

  it.each([
    ["wrong checkpoint version", { version: 2, completedItems: [], remainingAcceptanceItems: [] }],
    ["non-array completed items", { version: 1, completedItems: "done", remainingAcceptanceItems: [] }],
    ["empty completed item", { version: 1, completedItems: [""], remainingAcceptanceItems: [] }],
    ["too many remaining items", { version: 1, completedItems: [], remainingAcceptanceItems: Array.from({ length: 17 }, (_, index) => `item-${index}`) }],
  ])("rejects %s", (_name, completionCheckpoint) => {
    expect(
      extractPaperclipRunDisposition(
        envelope({
          version: 1,
          kind: "continue_same_issue",
          nextAction: "Continue.",
          completionCheckpoint,
        }),
        binding,
      ),
    ).toBeNull();
  });

  it("rejects a checkpoint whose serialized form exceeds the renderer boundary", () => {
    expect(parseCompletionCheckpoint({
      version: 1,
      completedItems: Array.from(
        { length: 16 },
        (_, index) => `${index}-${"x".repeat(300)}`,
      ),
      remainingAcceptanceItems: [],
    })).toBeNull();
    expect(parseCompletionCheckpoint({
      version: 1,
      completedItems: Array.from({ length: 16 }, () => "🙂".repeat(100)),
      remainingAcceptanceItems: [],
    })).toBeNull();
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
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).toContain("remainingAcceptanceItems");
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).not.toContain("companyId");
    expect(PAPERCLIP_RUN_DISPOSITION_INSTRUCTION).not.toContain("workspaceId");
  });
});
