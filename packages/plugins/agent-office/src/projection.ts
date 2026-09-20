export type OfficeState = "idle" | "thinking" | "executing" | "waiting" | "error";

export interface OfficeAgentInput {
  id: string;
  name: string;
  status: string;
}

export interface OfficeIssueInput {
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  pendingApproval?: boolean;
}

export interface OfficeRunInput {
  id: string;
  agentId: string | null;
  status: string;
  issueId?: string | null;
  createdAt?: string;
}

export interface OfficeRoom {
  id: string;
  label: string;
  state: OfficeState;
  taskTitle: string | null;
  channel: string;
}

export interface OfficeProjectionInput {
  agents: OfficeAgentInput[];
  issues: OfficeIssueInput[];
  runs: OfficeRunInput[];
}

const INITIAL_TEAM = [
  "ORP Developer",
  "Whattsi Developer",
  "Team Lead",
  "Codex Agent",
  "Hermes Agent",
] as const;

const FAILED_RUN_STATUSES = new Set(["failed", "error", "timed_out"]);
const FAILED_RUN_FRESHNESS_MS = 15 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["running", "in_progress", "started"]);
const ACTIVE_ISSUE_STATUSES = new Set(["in_progress", "in_review"]);
const QUEUED_ISSUE_STATUSES = new Set(["todo", "backlog", "queued"]);

function channelFor(agentName: string): string {
  const normalizedName = agentName.toLowerCase();
  if (normalizedName.includes("codex")) return "codex";
  if (normalizedName.includes("hermes")) return "hermes";
  return "paperclip";
}

function newestRun(runs: OfficeRunInput[]): OfficeRunInput | undefined {
  return runs.reduce<OfficeRunInput | undefined>((newest, run) => {
    if (!newest) return run;
    const newestTime = Date.parse(newest.createdAt ?? "");
    const runTime = Date.parse(run.createdAt ?? "");
    return Number.isFinite(runTime) && (!Number.isFinite(newestTime) || runTime > newestTime)
      ? run
      : newest;
  }, undefined);
}

function isCurrentFailure(run: OfficeRunInput): boolean {
  if (!FAILED_RUN_STATUSES.has(run.status)) return false;
  if (!run.createdAt) return true;

  const createdAt = Date.parse(run.createdAt);
  return !Number.isFinite(createdAt) || Date.now() - createdAt <= FAILED_RUN_FRESHNESS_MS;
}

function projectState(
  agentId: string,
  issues: OfficeIssueInput[],
  runs: OfficeRunInput[],
): Pick<OfficeRoom, "state" | "taskTitle"> {
  const agentIssues = issues.filter((issue) => issue.assigneeAgentId === agentId);
  const agentRuns = runs.filter((run) => run.agentId === agentId);
  const issueById = new Map(agentIssues.map((issue) => [issue.id, issue]));
  const latestRun = newestRun(agentRuns);

  if (latestRun && isCurrentFailure(latestRun)) {
    return {
      state: "error",
      taskTitle: (latestRun.issueId && issueById.get(latestRun.issueId)?.title) ?? agentIssues[0]?.title ?? null,
    };
  }

  const approvalIssue = agentIssues.find((issue) => issue.pendingApproval);
  if (approvalIssue) return { state: "waiting", taskTitle: approvalIssue.title };

  if (latestRun && ACTIVE_RUN_STATUSES.has(latestRun.status)) {
    return {
      state: "executing",
      taskTitle: (latestRun.issueId && issueById.get(latestRun.issueId)?.title) ?? agentIssues[0]?.title ?? null,
    };
  }

  const activeIssue = agentIssues.find((issue) => ACTIVE_ISSUE_STATUSES.has(issue.status));
  if (activeIssue) return { state: "executing", taskTitle: activeIssue.title };

  const queuedIssue = agentIssues.find((issue) => QUEUED_ISSUE_STATUSES.has(issue.status));
  if (queuedIssue) return { state: "thinking", taskTitle: queuedIssue.title };

  return { state: "idle", taskTitle: null };
}

export function projectOfficeRooms({ agents, issues, runs }: OfficeProjectionInput): OfficeRoom[] {
  const agentByName = new Map(agents.map((agent) => [agent.name, agent]));

  return INITIAL_TEAM.flatMap((name) => {
    const agent = agentByName.get(name);
    if (!agent) return [];

    return [{
      id: agent.id,
      label: agent.name,
      channel: channelFor(agent.name),
      ...projectState(agent.id, issues, runs),
    }];
  });
}
