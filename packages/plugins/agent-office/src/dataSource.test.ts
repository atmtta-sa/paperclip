import { describe, expect, it, vi } from "vitest";
import { loadOfficeProjection } from "./dataSource.js";

const agents = [{ id: "orp", name: "ORP Developer", status: "active" }];
const issues = [{ id: "issue-1", title: "Build API", status: "in_progress", assigneeAgentId: "orp" }];
const liveRuns = [{ id: "run-1", agentId: "orp", status: "running", issueId: "issue-1" }];
const recentRuns = [
  { id: "run-1", agentId: "orp", status: "running", issueId: "issue-1" },
  { id: "run-0", agentId: "orp", status: "succeeded", issueId: "issue-1" },
];

describe("Agent Office Paperclip data source", () => {
  it("reads company agents, issues, live runs, and recent runs without writes", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path.endsWith("/agents")) return agents;
      if (path.endsWith("/issues?limit=200")) return issues;
      if (path.includes("/live-runs?")) return liveRuns;
      return recentRuns;
    });

    const result = await loadOfficeProjection("company-1", readJson);

    expect(readJson.mock.calls.map(([path]) => path)).toEqual([
      "/api/companies/company-1/agents",
      "/api/companies/company-1/issues?limit=200",
      "/api/companies/company-1/live-runs?minCount=5&limit=50",
      "/api/companies/company-1/heartbeat-runs?limit=50",
    ]);
    expect(result.runs).toEqual([liveRuns[0], recentRuns[1]]);
    expect(readJson.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it("URL-encodes the company boundary", async () => {
    const readJson = vi.fn(async () => []);

    await loadOfficeProjection("company/unsafe", readJson);

    expect(readJson).toHaveBeenCalledWith("/api/companies/company%2Funsafe/agents");
  });
});
