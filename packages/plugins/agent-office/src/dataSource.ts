import type {
  OfficeAgentInput,
  OfficeIssueInput,
  OfficeProjectionInput,
  OfficeRunInput,
} from "./projection.js";

export type OfficeJsonReader = (path: string) => Promise<unknown>;

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
  const [agents, issues, liveRuns, recentRuns] = await Promise.all([
    readJson(`/api/companies/${company}/agents`),
    readJson(`/api/companies/${company}/issues?limit=200`),
    readJson(`/api/companies/${company}/live-runs?minCount=5&limit=50`),
    readJson(`/api/companies/${company}/heartbeat-runs?limit=50`),
  ]);

  return {
    agents: agents as OfficeAgentInput[],
    issues: issues as OfficeIssueInput[],
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
