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
      if (path.endsWith("/approvals?status=pending")) return [];
      return recentRuns;
    });

    const result = await loadOfficeProjection("company-1", readJson);

    expect(readJson.mock.calls.map(([path]) => path)).toEqual([
      "/api/companies/company-1/agents",
      "/api/companies/company-1/issues?limit=200",
      "/api/companies/company-1/live-runs?minCount=5&limit=50",
      "/api/companies/company-1/heartbeat-runs?limit=50",
      "/api/companies/company-1/approvals?status=pending",
    ]);
    expect(result.runs).toEqual([liveRuns[0], recentRuns[1]]);
    expect(readJson.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it("marks only issues linked to pending approvals as waiting", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path.endsWith("/agents")) return agents;
      if (path.endsWith("/issues?limit=200")) {
        return [
          ...issues,
          { id: "issue-2", title: "Already decided", status: "blocked", assigneeAgentId: "orp" },
        ];
      }
      if (path.includes("/live-runs?") || path.includes("/heartbeat-runs?")) return [];
      if (path.endsWith("/approvals?status=pending")) return [{ id: "approval-pending", status: "pending" }];
      if (path.endsWith("/approvals/approval-pending/issues")) return [issues[0]];
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await loadOfficeProjection("company-1", readJson);

    expect(result.issues).toEqual([
      { ...issues[0], pendingApproval: true },
      { id: "issue-2", title: "Already decided", status: "blocked", assigneeAgentId: "orp", pendingApproval: false },
    ]);
    expect(readJson).toHaveBeenCalledWith("/api/companies/company-1/approvals?status=pending");
    expect(readJson).toHaveBeenCalledWith("/api/approvals/approval-pending/issues");
  });

  it("ignores resolved approvals and linked issues outside the company issue list", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path.endsWith("/agents")) return agents;
      if (path.endsWith("/issues?limit=200")) return issues;
      if (path.includes("/live-runs?") || path.includes("/heartbeat-runs?")) return [];
      if (path.endsWith("/approvals?status=pending")) {
        return [
          { id: "approval-resolved", status: "approved" },
          { id: "approval-pending", status: "pending" },
        ];
      }
      if (path.endsWith("/approvals/approval-pending/issues")) {
        return [
          issues[0],
          issues[0],
          { id: "other-company-issue", title: "Private", status: "blocked", assigneeAgentId: "orp" },
        ];
      }
      throw new Error(`unexpected read: ${path}`);
    });

    const result = await loadOfficeProjection("company-1", readJson);

    expect(result.issues).toEqual([{ ...issues[0], pendingApproval: true }]);
    expect(readJson).not.toHaveBeenCalledWith("/api/approvals/approval-resolved/issues");
    expect(result.issues.some((issue) => issue.id === "other-company-issue")).toBe(false);
  });

  it("fails clearly when approval data is malformed", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path.endsWith("/approvals?status=pending")) return { approvals: [] };
      return [];
    });

    await expect(loadOfficeProjection("company-1", readJson))
      .rejects.toThrow("Paperclip approvals response must be an array");
  });

  it("URL-encodes company and approval boundaries", async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path.endsWith("/approvals?status=pending")) {
        return [{ id: "approval/unsafe", status: "pending" }];
      }
      return [];
    });

    await loadOfficeProjection("company/unsafe", readJson);

    expect(readJson).toHaveBeenCalledWith("/api/companies/company%2Funsafe/agents");
    expect(readJson).toHaveBeenCalledWith("/api/approvals/approval%2Funsafe/issues");
  });
});
