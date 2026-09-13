import type {
  OfficeAgentInput,
  OfficeIssueInput,
  OfficeProjectionInput,
  OfficeRunInput,
} from "./projection.js";

export type OfficeJsonReader = (path: string) => Promise<unknown>;

interface OfficeApprovalInput {
  id: string;
  status: string;
}

function uniqueRuns(runs: OfficeRunInput[]): OfficeRunInput[] {
  const byId = new Map<string, OfficeRunInput>();
  runs.forEach((run) => {
    if (!byId.has(run.id)) byId.set(run.id, run);
  });
  return [...byId.values()];
}

export async function loadOfficeProjection(
  companyId: string,
  readJson: OfficeJsonReader,
): Promise<OfficeProjectionInput> {
  const company = encodeURIComponent(companyId);
  const [agents, issues, liveRuns, recentRuns, approvals] = await Promise.all([
    readJson(`/api/companies/${company}/agents`),
    readJson(`/api/companies/${company}/issues?limit=200`),
    readJson(`/api/companies/${company}/live-runs?minCount=5&limit=50`),
    readJson(`/api/companies/${company}/heartbeat-runs?limit=50`),
    readJson(`/api/companies/${company}/approvals?status=pending`),
  ]);

  if (!Array.isArray(approvals)) {
    throw new Error("Paperclip approvals response must be an array");
  }
  const pendingApprovals = (approvals as OfficeApprovalInput[])
    .filter((approval) => approval.status === "pending");
  const linkedIssues = await Promise.all(pendingApprovals.map((approval) =>
    readJson(`/api/approvals/${encodeURIComponent(approval.id)}/issues`)
      .then((rows) => rows as OfficeIssueInput[]),
  ));
  const pendingIssueIds = new Set(linkedIssues.flat().map((issue) => issue.id));

  return {
    agents: agents as OfficeAgentInput[],
    issues: (issues as OfficeIssueInput[]).map((issue) => ({
      ...issue,
      pendingApproval: pendingIssueIds.has(issue.id),
    })),
    runs: uniqueRuns([
      ...(liveRuns as OfficeRunInput[]),
      ...(recentRuns as OfficeRunInput[]),
    ]),
  };
}

export async function readHostJson(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error(`Paperclip read failed (${response.status})`);
  return response.json();
}
