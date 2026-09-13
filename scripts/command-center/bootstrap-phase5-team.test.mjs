import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTeamPlan,
  provisionTeam,
} from "./bootstrap-phase5-team.mjs";

const workspaces = {
  lead: "/tmp/paperclip-phase5/lead",
  orp: "/tmp/paperclip-phase5/orp",
  whattsi: "/tmp/paperclip-phase5/whattsi",
  codex: "/tmp/paperclip-phase5/codex",
  hermes: "/tmp/paperclip-phase5/hermes",
};

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("dry-run plan defines the governed five-agent hierarchy without network access", () => {
  const plan = buildTeamPlan({ workspaces, disposableRoot: "/tmp/paperclip-phase5" });

  assert.deepEqual(plan.agents.map((agent) => agent.name), [
    "Team Lead",
    "ORP Developer",
    "Whattsi Developer",
    "Codex Agent",
    "Hermes Agent",
  ]);
  assert.deepEqual(plan.agents.map((agent) => agent.role), [
    "cto",
    "engineer",
    "engineer",
    "engineer",
    "engineer",
  ]);
  assert.equal(plan.agents[0].reportsTo, null);
  assert.ok(plan.agents.slice(1).every((agent) => agent.reportsTo === "$TEAM_LEAD_ID"));
  assert.deepEqual(plan.agents.map((agent) => agent.adapterType), [
    "hermes_local",
    "hermes_local",
    "hermes_local",
    "codex_local",
    "hermes_local",
  ]);
  assert.equal(plan.openClawEnabled, false);
  assert.equal(plan.schedulerRequiredState, "disabled");
});

test("rejects non-disposable workspace paths before any network request", async () => {
  let calls = 0;

  await assert.rejects(
    provisionTeam({
      baseUrl: "http://127.0.0.1:3100",
      companyName: "Command Center Phase 5 UAT",
      workspaces: { ...workspaces, orp: "/mnt/c/orchestration-platform" },
      disposableRoot: "/tmp/paperclip-phase5",
      allowApply: true,
      schedulerDisabled: true,
      fetchImpl: async () => {
        calls += 1;
        return response({});
      },
    }),
    /outside disposable root/,
  );
  assert.equal(calls, 0);
});

test("requires both explicit apply and disabled-scheduler evidence", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({});
  };

  await assert.rejects(
    provisionTeam({
      baseUrl: "http://127.0.0.1:3100",
      companyName: "Command Center Phase 5 UAT",
      workspaces,
      disposableRoot: "/tmp/paperclip-phase5",
      allowApply: false,
      schedulerDisabled: true,
      fetchImpl,
    }),
    /explicit apply/,
  );
  await assert.rejects(
    provisionTeam({
      baseUrl: "http://127.0.0.1:3100",
      companyName: "Command Center Phase 5 UAT",
      workspaces,
      disposableRoot: "/tmp/paperclip-phase5",
      allowApply: true,
      schedulerDisabled: false,
      fetchImpl,
    }),
    /scheduler.*disabled/i,
  );
  assert.equal(calls, 0);
});

test("rejects a non-loopback Paperclip API before any network request", async () => {
  let calls = 0;

  await assert.rejects(
    provisionTeam({
      baseUrl: "https://paperclip.example.test",
      companyName: "Command Center Phase 5 UAT",
      workspaces,
      disposableRoot: "/tmp/paperclip-phase5",
      allowApply: true,
      schedulerDisabled: true,
      fetchImpl: async () => {
        calls += 1;
        return response({});
      },
    }),
    /loopback/,
  );
  assert.equal(calls, 0);
});

test("creates or reuses exactly five agents and pauses each before continuing", async () => {
  const calls = [];
  const createdAgents = [];
  let nextAgent = 1;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, url, body });

    if (url.endsWith("/api/companies") && method === "GET") return response([]);
    if (url.endsWith("/api/companies") && method === "POST") {
      return response({ id: "company-1", name: body.name }, 201);
    }
    if (url.endsWith("/api/companies/company-1/agents") && method === "GET") {
      return response(createdAgents);
    }
    if (url.endsWith("/api/companies/company-1/agents") && method === "POST") {
      const agent = { ...body, id: `agent-${nextAgent++}`, companyId: "company-1", status: "idle" };
      createdAgents.push(agent);
      return response(agent, 201);
    }
    if (/\/api\/agents\/agent-\d+\/pause$/.test(url) && method === "POST") {
      const id = url.match(/agent-\d+/)[0];
      const agent = createdAgents.find((entry) => entry.id === id);
      agent.status = "paused";
      return response(agent);
    }
    if (url.endsWith("/api/companies/company-1/org") && method === "GET") {
      return response({ id: "agent-1", reports: createdAgents.slice(1) });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  const result = await provisionTeam({
    baseUrl: "http://127.0.0.1:3100",
    companyName: "Command Center Phase 5 UAT",
    workspaces,
    disposableRoot: "/tmp/paperclip-phase5",
    allowApply: true,
    schedulerDisabled: true,
    fetchImpl,
  });

  assert.equal(result.agents.length, 5);
  assert.ok(result.agents.every((agent) => agent.status === "paused"));
  assert.equal(result.agents[0].reportsTo, null);
  assert.ok(result.agents.slice(1).every((agent) => agent.reportsTo === "agent-1"));
  const mutations = calls.filter((call) => call.method === "POST").slice(1);
  for (let index = 0; index < mutations.length; index += 2) {
    assert.match(mutations[index].url, /\/api\/companies\/company-1\/agents$/);
    assert.match(mutations[index + 1].url, /\/pause$/);
  }
});

test("fails closed when an existing named agent has a different adapter", async () => {
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (url.endsWith("/api/companies") && method === "GET") {
      return response([{ id: "company-1", name: "Command Center Phase 5 UAT" }]);
    }
    if (url.endsWith("/api/companies/company-1/agents") && method === "GET") {
      return response([{
        id: "agent-1",
        name: "Team Lead",
        role: "cto",
        reportsTo: null,
        adapterType: "openclaw_gateway",
        status: "paused",
      }]);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  await assert.rejects(
    provisionTeam({
      baseUrl: "http://127.0.0.1:3100",
      companyName: "Command Center Phase 5 UAT",
      workspaces,
      disposableRoot: "/tmp/paperclip-phase5",
      allowApply: true,
      schedulerDisabled: true,
      fetchImpl,
    }),
    /existing agent Team Lead does not match/,
  );
});

test("fails closed when an existing agent points at a different workspace", async () => {
  const expectedLead = buildTeamPlan({
    workspaces,
    disposableRoot: "/tmp/paperclip-phase5",
  }).agents[0];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    if (url.endsWith("/api/companies") && method === "GET") {
      return response([{ id: "company-1", name: "Command Center Phase 5 UAT" }]);
    }
    if (url.endsWith("/api/companies/company-1/agents") && method === "GET") {
      return response([{
        id: "agent-1",
        name: "Team Lead",
        role: expectedLead.role,
        title: expectedLead.title,
        capabilities: expectedLead.capabilities,
        reportsTo: null,
        adapterType: expectedLead.adapterType,
        adapterConfig: { ...expectedLead.adapterConfig, cwd: "/tmp/other/lead" },
        budgetMonthlyCents: expectedLead.budgetMonthlyCents,
        status: "paused",
      }]);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  await assert.rejects(
    provisionTeam({
      baseUrl: "http://127.0.0.1:3100",
      companyName: "Command Center Phase 5 UAT",
      workspaces,
      disposableRoot: "/tmp/paperclip-phase5",
      allowApply: true,
      schedulerDisabled: true,
      fetchImpl,
    }),
    /existing agent Team Lead does not match/,
  );
});
