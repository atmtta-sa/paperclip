import { describe, expect, it, vi } from "vitest";
import {
  chatTaskDispatchService,
  formatChatTaskDispatchResult,
  parseStartNextTaskCommand,
  type ChatTaskDispatchRepository,
} from "./chat-task-dispatch.js";

const agent = {
  id: "agent-1",
  name: "Visualization Tool Developer",
};

const readyIssue = {
  id: "issue-1",
  identifier: "COM-268",
  title: "Inspect repository and establish isolated worktree",
  status: "in_progress",
  hasUnresolvedBlockers: false,
  hasActiveExecution: false,
};

function repository(
  overrides: Partial<ChatTaskDispatchRepository> = {},
): ChatTaskDispatchRepository {
  return {
    findAgentsByExactName: vi.fn(async () => [agent]),
    listRunnableIssueCandidates: vi.fn(async () => [readyIssue]),
    ...overrides,
  };
}

describe("parseStartNextTaskCommand", () => {
  it.each([
    ["/start-next Visualization Tool Developer", "Visualization Tool Developer"],
    ["start-next Visualization Tool Developer", "Visualization Tool Developer"],
    [" /START-NEXT@paperclip_bot   Visualization Tool Developer ", "Visualization Tool Developer"],
  ])("parses the explicit command %s", (text, expected) => {
    expect(parseStartNextTaskCommand(text)).toEqual({ agentName: expected });
  });

  it.each([
    "start the developer's next task",
    "start-next",
    "/start-next",
    "/start-next   ",
    "/new Visualization Tool Developer",
  ])("leaves non-command text on the normal chat path: %s", (text) => {
    expect(parseStartNextTaskCommand(text)).toBeNull();
  });
});

describe("chatTaskDispatchService", () => {
  it("wakes the only exact-agent runnable leaf with Board-user attribution", async () => {
    const repo = repository();
    const wakeup = vi.fn(async () => ({ id: "run-1" }));
    const service = chatTaskDispatchService(repo, { wakeup }, async () => true);

    const result = await service.startNext({
      companyId: "company-1",
      requestedByUserId: "user-1",
      agentName: "Visualization Tool Developer",
      idempotencyKey: "chat-start-next:delivery-1",
    });

    expect(result).toEqual({
      kind: "started",
      agent,
      issue: readyIssue,
      runId: "run-1",
    });
    expect(repo.findAgentsByExactName).toHaveBeenCalledWith(
      "company-1",
      "Visualization Tool Developer",
    );
    expect(repo.listRunnableIssueCandidates).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
    );
    expect(wakeup).toHaveBeenCalledWith("agent-1", {
      manualUserWake: true,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "user_directed_task_start",
      payload: {
        issueId: "issue-1",
        taskKey: "issue-1",
        mutation: "chat_start_next_task",
      },
      idempotencyKey: "chat-start-next:delivery-1",
      issueStateGuard: {
        statuses: ["todo", "in_progress"],
        assigneeAgentId: "agent-1",
      },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      contextSnapshot: {
        issueId: "issue-1",
        taskKey: "issue-1",
        resumeIntent: true,
        triggeredBy: "board",
        responsibleUserId: "user-1",
        source: "chat:start-next",
      },
    });
  });

  it("fails closed when the exact agent name is absent or ambiguous", async () => {
    for (const matches of [[], [agent, { ...agent, id: "agent-2" }]]) {
      const repo = repository({
        findAgentsByExactName: vi.fn(async () => matches),
      });
      const wakeup = vi.fn();

      const result = await chatTaskDispatchService(repo, { wakeup }, async () => true).startNext({
        companyId: "company-1",
        requestedByUserId: "user-1",
        agentName: agent.name,
        idempotencyKey: "chat-start-next:delivery-1",
      });

      expect(result.kind).toBe(matches.length === 0 ? "agent_not_found" : "agent_ambiguous");
      expect(wakeup).not.toHaveBeenCalled();
    }
  });

  it("fails closed when zero or multiple runnable leaves exist", async () => {
    for (const candidates of [
      [],
      [readyIssue, { ...readyIssue, id: "issue-2", identifier: "COM-269" }],
    ]) {
      const repo = repository({
        listRunnableIssueCandidates: vi.fn(async () => candidates),
      });
      const wakeup = vi.fn();

      const result = await chatTaskDispatchService(repo, { wakeup }, async () => true).startNext({
        companyId: "company-1",
        requestedByUserId: "user-1",
        agentName: agent.name,
        idempotencyKey: "chat-start-next:delivery-1",
      });

      expect(result.kind).toBe(candidates.length === 0 ? "no_ready_task" : "task_ambiguous");
      expect(wakeup).not.toHaveBeenCalled();
    }
  });

  it("excludes blocked tasks and tasks with live execution ownership", async () => {
    const repo = repository({
      listRunnableIssueCandidates: vi.fn(async () => [
        { ...readyIssue, hasUnresolvedBlockers: true },
        { ...readyIssue, id: "issue-2", hasActiveExecution: true },
      ]),
    });
    const wakeup = vi.fn();

    const result = await chatTaskDispatchService(repo, { wakeup }, async () => true).startNext({
      companyId: "company-1",
      requestedByUserId: "user-1",
      agentName: agent.name,
      idempotencyKey: "chat-start-next:delivery-1",
    });

    expect(result.kind).toBe("no_ready_task");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("does not report success when the wake is not admitted", async () => {
    const service = chatTaskDispatchService(
      repository(),
      {
        wakeup: vi.fn(async () => null),
      },
      async () => true,
    );

    const result = await service.startNext({
      companyId: "company-1",
      requestedByUserId: "user-1",
      agentName: agent.name,
      idempotencyKey: "chat-start-next:delivery-1",
    });

    expect(result).toEqual({
      kind: "wake_not_started",
      agent,
      issue: readyIssue,
    });
  });

  it("fails closed when the linked user lacks agent wake authority", async () => {
    const wakeup = vi.fn(async () => ({ id: "run-1" }));
    const authorizeAgentWake = vi.fn(async () => false);
    const service = chatTaskDispatchService(
      repository(),
      { wakeup },
      authorizeAgentWake,
    );

    const result = await service.startNext({
      companyId: "company-1",
      requestedByUserId: "viewer-1",
      agentName: agent.name,
      idempotencyKey: "chat-start-next:delivery-1",
    });

    expect(result).toEqual({ kind: "not_authorized", agent });
    expect(authorizeAgentWake).toHaveBeenCalledWith({
      companyId: "company-1",
      userId: "viewer-1",
      agentId: "agent-1",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });
});

describe("formatChatTaskDispatchResult", () => {
  it("reports the exact admitted task and agent", () => {
    expect(
      formatChatTaskDispatchResult({
        kind: "started",
        agent,
        issue: readyIssue,
        runId: "run-1",
      }),
    ).toBe(
      "Started COM-268: Inspect repository and establish isolated worktree with Visualization Tool Developer.",
    );
  });

  it.each([
    [
      { kind: "agent_not_found" as const },
      "No active agent has that exact name. Nothing was started.",
    ],
    [
      { kind: "agent_ambiguous" as const },
      "More than one active agent has that exact name. Nothing was started.",
    ],
    [
      { kind: "not_authorized" as const, agent },
      "You are not authorized to start Visualization Tool Developer. Nothing was started.",
    ],
    [
      { kind: "no_ready_task" as const, agent },
      "Visualization Tool Developer does not have exactly one runnable task. Nothing was started.",
    ],
    [
      {
        kind: "task_ambiguous" as const,
        agent,
        issues: [readyIssue, { ...readyIssue, id: "issue-2" }],
      },
      "Visualization Tool Developer has multiple runnable tasks. Nothing was started.",
    ],
    [
      { kind: "wake_not_started" as const, agent, issue: readyIssue },
      "COM-268 was selected, but its run was not admitted. Nothing was started.",
    ],
  ])("formats a fail-closed result", (result, expected) => {
    expect(formatChatTaskDispatchResult(result)).toBe(expected);
  });
});
