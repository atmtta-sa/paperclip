export interface ChatTaskDispatchAgent {
  id: string;
  name: string;
}

export interface ChatTaskDispatchIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  hasUnresolvedBlockers: boolean;
  hasActiveExecution: boolean;
}

export interface ChatTaskDispatchRepository {
  findAgentsByExactName(
    companyId: string,
    agentName: string,
  ): Promise<ChatTaskDispatchAgent[]>;
  listRunnableIssueCandidates(
    companyId: string,
    agentId: string,
  ): Promise<ChatTaskDispatchIssue[]>;
}

interface ChatTaskDispatchHeartbeat {
  wakeup(
    agentId: string,
    options: {
      manualUserWake: true;
      source: "on_demand";
      triggerDetail: "manual";
      reason: "user_directed_task_start";
      payload: {
        issueId: string;
        taskKey: string;
        mutation: "chat_start_next_task";
      };
      idempotencyKey: string;
      issueStateGuard: {
        statuses: ["todo", "in_progress"];
        assigneeAgentId: string;
      };
      requestedByActorType: "user";
      requestedByActorId: string;
      contextSnapshot: {
        issueId: string;
        taskKey: string;
        resumeIntent: true;
        triggeredBy: "board";
        responsibleUserId: string;
        source: "chat:start-next";
      };
    },
  ): Promise<unknown>;
}

export type ChatTaskDispatchResult =
  | { kind: "agent_not_found" }
  | { kind: "agent_ambiguous" }
  | { kind: "not_authorized"; agent: ChatTaskDispatchAgent }
  | { kind: "no_ready_task"; agent: ChatTaskDispatchAgent }
  | {
      kind: "task_ambiguous";
      agent: ChatTaskDispatchAgent;
      issues: ChatTaskDispatchIssue[];
    }
  | {
      kind: "wake_not_started";
      agent: ChatTaskDispatchAgent;
      issue: ChatTaskDispatchIssue;
    }
  | {
      kind: "started";
      agent: ChatTaskDispatchAgent;
      issue: ChatTaskDispatchIssue;
      runId: string | null;
    };

export function parseStartNextTaskCommand(
  text: string,
): { agentName: string } | null {
  const match = /^\/?start-next(?:@[\w.-]+)?\s+(.{1,160})$/i.exec(text.trim());
  const agentName = match?.[1]?.trim();
  return agentName ? { agentName } : null;
}

export function formatChatTaskDispatchResult(
  result: ChatTaskDispatchResult,
): string {
  switch (result.kind) {
    case "started":
      return `Started ${result.issue.identifier}: ${result.issue.title} with ${result.agent.name}.`;
    case "agent_not_found":
      return "No active agent has that exact name. Nothing was started.";
    case "agent_ambiguous":
      return "More than one active agent has that exact name. Nothing was started.";
    case "not_authorized":
      return `You are not authorized to start ${result.agent.name}. Nothing was started.`;
    case "no_ready_task":
      return `${result.agent.name} does not have exactly one runnable task. Nothing was started.`;
    case "task_ambiguous":
      return `${result.agent.name} has multiple runnable tasks. Nothing was started.`;
    case "wake_not_started":
      return `${result.issue.identifier} was selected, but its run was not admitted. Nothing was started.`;
  }
}

export function chatTaskDispatchService(
  repository: ChatTaskDispatchRepository,
  heartbeat: ChatTaskDispatchHeartbeat,
  authorizeAgentWake: (input: {
    companyId: string;
    userId: string;
    agentId: string;
  }) => Promise<boolean>,
) {
  return {
    async startNext(input: {
      companyId: string;
      requestedByUserId: string;
      agentName: string;
      idempotencyKey: string;
    }): Promise<ChatTaskDispatchResult> {
      const agents = await repository.findAgentsByExactName(
        input.companyId,
        input.agentName,
      );
      if (agents.length === 0) return { kind: "agent_not_found" };
      if (agents.length !== 1) return { kind: "agent_ambiguous" };

      const agent = agents[0]!;
      const authorized = await authorizeAgentWake({
        companyId: input.companyId,
        userId: input.requestedByUserId,
        agentId: agent.id,
      });
      if (!authorized) return { kind: "not_authorized", agent };
      const candidates = await repository.listRunnableIssueCandidates(
        input.companyId,
        agent.id,
      );
      const runnable = candidates.filter(
        (issue) =>
          !issue.hasUnresolvedBlockers && !issue.hasActiveExecution,
      );
      if (runnable.length === 0) return { kind: "no_ready_task", agent };
      if (runnable.length !== 1) {
        return { kind: "task_ambiguous", agent, issues: runnable };
      }

      const issue = runnable[0]!;
      const wake = await heartbeat.wakeup(agent.id, {
        manualUserWake: true,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "user_directed_task_start",
        payload: {
          issueId: issue.id,
          taskKey: issue.id,
          mutation: "chat_start_next_task",
        },
        idempotencyKey: input.idempotencyKey,
        issueStateGuard: {
          statuses: ["todo", "in_progress"],
          assigneeAgentId: agent.id,
        },
        requestedByActorType: "user",
        requestedByActorId: input.requestedByUserId,
        contextSnapshot: {
          issueId: issue.id,
          taskKey: issue.id,
          resumeIntent: true,
          triggeredBy: "board",
          responsibleUserId: input.requestedByUserId,
          source: "chat:start-next",
        },
      });
      const runId =
        wake &&
        typeof wake === "object" &&
        "id" in wake &&
        typeof wake.id === "string"
          ? wake.id
          : null;
      if (!runId) return { kind: "wake_not_started", agent, issue };
      return { kind: "started", agent, issue, runId };
    },
  };
}
