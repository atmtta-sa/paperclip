import { describe, expect, it } from "vitest";
import { projectOfficeRooms } from "./projection.js";

const agents = [
  { id: "orp", name: "ORP Developer", status: "active" },
  { id: "whattsi", name: "Whattsi Developer", status: "active" },
  { id: "lead", name: "Team Lead", status: "active" },
  { id: "codex", name: "Codex Agent", status: "active" },
  { id: "hermes", name: "Hermes Agent", status: "active" },
];

describe("Paperclip to Agent Office projection", () => {
  it("projects the five configured team roles as stable Office rooms", () => {
    const rooms = projectOfficeRooms({ agents, issues: [], runs: [] });

    expect(rooms.map((room) => room.id)).toEqual([
      "orp",
      "whattsi",
      "lead",
      "codex",
      "hermes",
    ]);
    expect(rooms.map((room) => room.label)).toEqual([
      "ORP Developer",
      "Whattsi Developer",
      "Team Lead",
      "Codex Agent",
      "Hermes Agent",
    ]);
    expect(rooms.every((room) => room.state === "idle")).toBe(true);
  });

  it("uses error, approval, active, queued, then idle lifecycle priority", () => {
    const rooms = projectOfficeRooms({
      agents,
      issues: [
        { id: "issue-error", title: "Broken build", status: "in_progress", assigneeAgentId: "orp" },
        { id: "issue-wait", title: "Needs approval", status: "blocked", assigneeAgentId: "whattsi", pendingApproval: true },
        { id: "issue-active", title: "Implement feature", status: "in_progress", assigneeAgentId: "lead" },
        { id: "issue-queued", title: "Review task", status: "todo", assigneeAgentId: "codex" },
      ],
      runs: [
        { id: "run-error", agentId: "orp", status: "failed", issueId: "issue-error" },
        { id: "run-active", agentId: "lead", status: "running", issueId: "issue-active" },
      ],
    });

    expect(rooms.map(({ id, state, taskTitle }) => ({ id, state, taskTitle }))).toEqual([
      { id: "orp", state: "error", taskTitle: "Broken build" },
      { id: "whattsi", state: "waiting", taskTitle: "Needs approval" },
      { id: "lead", state: "executing", taskTitle: "Implement feature" },
      { id: "codex", state: "thinking", taskTitle: "Review task" },
      { id: "hermes", state: "idle", taskTitle: null },
    ]);
  });

  it("does not keep a room in error for a stale failed run", () => {
    const rooms = projectOfficeRooms({
      agents,
      issues: [
        { id: "issue-error", title: "Current work", status: "in_progress", assigneeAgentId: "lead" },
      ],
      runs: [
        {
          id: "stale-failure",
          agentId: "lead",
          status: "failed",
          issueId: "issue-error",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(rooms.find((room) => room.id === "lead")).toMatchObject({
      state: "executing",
      taskTitle: "Current work",
    });
  });

  it("uses only the newest run when projecting run state", () => {
    const newerSuccess = projectOfficeRooms({
      agents,
      issues: [],
      runs: [
        { id: "old-failure", agentId: "orp", status: "failed", createdAt: "2026-09-12T10:00:00.000Z" },
        { id: "new-success", agentId: "orp", status: "succeeded", createdAt: "2026-09-12T10:01:00.000Z" },
      ],
    });
    const newerActive = projectOfficeRooms({
      agents,
      issues: [],
      runs: [
        { id: "old-failure", agentId: "orp", status: "failed", createdAt: "2026-09-12T10:00:00.000Z" },
        { id: "new-active", agentId: "orp", status: "running", createdAt: "2026-09-12T10:01:00.000Z" },
      ],
    });

    expect(newerSuccess[0]?.state).toBe("idle");
    expect(newerActive[0]?.state).toBe("executing");
  });

  it("does not project agents outside the configured team", () => {
    const rooms = projectOfficeRooms({
      agents: [...agents, { id: "extra", name: "Unconfigured Agent", status: "active" }],
      issues: [],
      runs: [],
    });

    expect(rooms).toHaveLength(5);
    expect(rooms.some((room) => room.id === "extra")).toBe(false);
  });
});
