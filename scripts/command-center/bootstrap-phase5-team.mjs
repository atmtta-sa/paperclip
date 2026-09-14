#!/usr/bin/env node

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyDisposableGitWorkspaces } from "./phase5-workspace-guards.mjs";

const LEAD_NAME = "Team Lead";
const TEAM_LEAD_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("./team-lead/AGENTS.md", import.meta.url),
);
const TEAM_LEAD_SKILLS = [
  "paperclipai/paperclip/paperclip",
  "paperclipai/paperclip/paperclip-converting-plans-to-tasks",
];
const ORP_DEVELOPER_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("./orp-developer/AGENTS.md", import.meta.url),
);
const ORP_DEVELOPER_SKILLS = ["paperclipai/paperclip/paperclip"];
const HERMES_PERSONAS = {
  lead: {
    instructionsFilePath: TEAM_LEAD_INSTRUCTIONS_PATH,
    desiredSkills: TEAM_LEAD_SKILLS,
  },
  orp: {
    instructionsFilePath: ORP_DEVELOPER_INSTRUCTIONS_PATH,
    desiredSkills: ORP_DEVELOPER_SKILLS,
  },
};
const TEAM = [
  {
    key: "lead",
    name: LEAD_NAME,
    role: "cto",
    title: "Team Lead / Supervisor",
    adapterType: "hermes_local",
    capabilities: "Coordination and review without automatic deploy authority",
  },
  {
    key: "orp",
    name: "ORP Developer",
    role: "engineer",
    title: "ORP Developer",
    adapterType: "hermes_local",
    capabilities: "ORP implementation and review in the approved ORP checkout only",
  },
  {
    key: "whattsi",
    name: "Whattsi Developer",
    role: "engineer",
    title: "Whattsi Developer",
    adapterType: "hermes_local",
    capabilities: "Whattsi implementation and review in the approved Whattsi checkout only",
  },
  {
    key: "codex",
    name: "Codex Agent",
    role: "engineer",
    title: "Codex Coding and Review Agent",
    adapterType: "codex_local",
    capabilities: "Explicitly assigned coding and review tasks",
  },
  {
    key: "hermes",
    name: "Hermes Agent",
    role: "engineer",
    title: "Hermes Coding and Review Agent",
    adapterType: "hermes_local",
    capabilities: "Explicitly assigned coding and review tasks",
  },
];

function ensureDisposableCompanyName(companyName) {
  if (!/(?:uat|disposable|synthetic)/i.test(companyName)) {
    throw new Error("company name must identify a UAT, disposable, or synthetic fixture");
  }
}

function ensureDisposableWorkspaces(workspaces, disposableRoot) {
  const root = path.resolve(disposableRoot);
  const resolved = TEAM.map(({ key }) => {
    const value = workspaces[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`missing workspace for ${key}`);
    }
    const workspace = path.resolve(value);
    if (workspace === root || !workspace.startsWith(`${root}${path.sep}`)) {
      throw new Error(`workspace ${key} is outside disposable root ${root}`);
    }
    return [key, workspace];
  });
  if (new Set(resolved.map(([, workspace]) => workspace)).size !== TEAM.length) {
    throw new Error("each agent requires a distinct disposable workspace");
  }
  return Object.fromEntries(resolved);
}

function hermesConfig(cwd, persona) {
  return {
    cwd,
    provider: "auto",
    persistSession: true,
    worktreeMode: true,
    checkpoints: true,
    quiet: true,
    timeoutSec: 300,
    graceSec: 10,
    maxTurnsPerRun: 20,
    toolsets: "terminal,file",
    ...(persona ? {
      instructionsFilePath: persona.instructionsFilePath,
      paperclipSkillSync: { desiredSkills: persona.desiredSkills },
    } : {}),
  };
}

function codexConfig(cwd) {
  return {
    cwd,
    engine: "acp",
    mode: "persistent",
    nonInteractivePermissions: "deny",
    warmHandleIdleMs: 0,
    dangerouslyBypassApprovalsAndSandbox: false,
    workspaceStrategy: { type: "git_worktree" },
  };
}

export function buildTeamPlan({ workspaces, disposableRoot }) {
  const safeWorkspaces = ensureDisposableWorkspaces(workspaces, disposableRoot);
  return {
    schedulerRequiredState: "disabled",
    openClawEnabled: false,
    agents: TEAM.map((member) => ({
      name: member.name,
      role: member.role,
      title: member.title,
      reportsTo: member.key === "lead" ? null : "$TEAM_LEAD_ID",
      capabilities: member.capabilities,
      adapterType: member.adapterType,
      adapterConfig: member.adapterType === "codex_local"
        ? codexConfig(safeWorkspaces[member.key])
        : hermesConfig(
          safeWorkspaces[member.key],
          HERMES_PERSONAS[member.key],
        ),
      budgetMonthlyCents: 0,
    })),
  };
}

function apiRoot(baseUrl) {
  const parsed = new URL(baseUrl);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("Paperclip API must use a credential-free loopback URL");
  }
  const normalized = parsed.href.replace(/\/+$/, "");
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

async function requestJson(fetchImpl, url, { method = "GET", body, apiKey } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`${method} ${url} failed with ${response.status}${detail}`);
  }
  return payload;
}

function objectContains(actual, expected) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => objectContains(actual[key], value));
}

function assertExistingAgent(agent, expected, reportsTo) {
  if (
    agent.role !== expected.role ||
    agent.title !== expected.title ||
    agent.capabilities !== expected.capabilities ||
    agent.adapterType !== expected.adapterType ||
    (agent.reportsTo ?? null) !== reportsTo ||
    agent.budgetMonthlyCents !== expected.budgetMonthlyCents ||
    !objectContains(agent.adapterConfig ?? {}, expected.adapterConfig)
  ) {
    throw new Error(`existing agent ${expected.name} does not match the governed team specification`);
  }
}

function assertInitialAgentSet(existingAgents, allowedNames) {
  const names = existingAgents.map((agent) => agent.name);
  if (new Set(names).size !== names.length) {
    throw new Error("existing agent names are not unique");
  }
  const unexpected = names.filter((name) => !allowedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`synthetic company contains unexpected agents: ${unexpected.join(", ")}`);
  }
}

function assertFinalTeam(agents, expectedAgents, leadId) {
  if (agents.length !== TEAM.length) throw new Error(`expected exactly five agents, received ${agents.length}`);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  for (const expected of expectedAgents) {
    const agent = byName.get(expected.name);
    if (!agent) throw new Error(`missing agent ${expected.name}`);
    assertExistingAgent(agent, expected, expected.name === LEAD_NAME ? null : leadId);
    if (agent.status !== "paused") throw new Error(`agent ${expected.name} is not paused`);
  }
}

export async function provisionTeam({
  baseUrl,
  companyName,
  workspaces,
  disposableRoot,
  allowApply,
  schedulerDisabled,
  fetchImpl = globalThis.fetch,
  apiKey,
  verifyWorkspaces = verifyDisposableGitWorkspaces,
}) {
  if (allowApply !== true) throw new Error("explicit apply approval is required");
  if (schedulerDisabled !== true) throw new Error("heartbeat scheduler must be disabled");
  ensureDisposableCompanyName(companyName);
  const plan = buildTeamPlan({ workspaces, disposableRoot });
  verifyWorkspaces(workspaces, disposableRoot);
  const root = apiRoot(baseUrl);
  const call = (pathname, options) => requestJson(fetchImpl, `${root}${pathname}`, { ...options, apiKey });

  const companies = await call("/companies");
  const matches = companies.filter((company) => company.name === companyName);
  if (matches.length > 1) throw new Error(`multiple companies named ${companyName}`);
  const company = matches[0] ?? await call("/companies", {
    method: "POST",
    body: { name: companyName, budgetMonthlyCents: 0 },
  });

  const existingAgents = await call(`/companies/${company.id}/agents`);
  assertInitialAgentSet(existingAgents, new Set(TEAM.map((member) => member.name)));
  const agentsByName = new Map(existingAgents.map((agent) => [agent.name, agent]));
  const provisioned = [];
  let leadId = agentsByName.get(LEAD_NAME)?.id ?? null;

  for (const expected of plan.agents) {
    const reportsTo = expected.name === LEAD_NAME ? null : leadId;
    if (expected.name !== LEAD_NAME && !reportsTo) throw new Error("Team Lead must exist before direct reports");
    const desired = { ...expected, reportsTo };
    let agent = agentsByName.get(expected.name);
    if (agent) {
      assertExistingAgent(agent, expected, reportsTo);
    } else {
      agent = await call(`/companies/${company.id}/agents`, { method: "POST", body: desired });
      agentsByName.set(agent.name, agent);
    }
    if (expected.name === LEAD_NAME) leadId = agent.id;
    if (agent.status !== "paused") {
      agent = await call(`/agents/${agent.id}/pause`, { method: "POST" });
      agentsByName.set(agent.name, agent);
    }
    provisioned.push(agent);
  }

  const finalAgents = await call(`/companies/${company.id}/agents`);
  const org = await call(`/companies/${company.id}/org`);
  assertFinalTeam(finalAgents, plan.agents, leadId);
  return { company, agents: finalAgents, org, provisionedAgentIds: provisioned.map((agent) => agent.id) };
}

function envWorkspaces() {
  return {
    lead: process.env.PAPERCLIP_PHASE5_LEAD_CWD,
    orp: process.env.PAPERCLIP_PHASE5_ORP_CWD,
    whattsi: process.env.PAPERCLIP_PHASE5_WHATTSI_CWD,
    codex: process.env.PAPERCLIP_PHASE5_CODEX_CWD,
    hermes: process.env.PAPERCLIP_PHASE5_HERMES_CWD,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const options = {
    baseUrl: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100",
    companyName: process.env.PAPERCLIP_PHASE5_COMPANY ?? "Command Center Phase 5 UAT",
    workspaces: envWorkspaces(),
    disposableRoot: process.env.PAPERCLIP_PHASE5_DISPOSABLE_ROOT,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(buildTeamPlan(options), null, 2)}\n`);
    return;
  }
  const result = await provisionTeam({
    ...options,
    allowApply: process.env.PAPERCLIP_PHASE5_APPLY === "1",
    schedulerDisabled: process.env.HEARTBEAT_SCHEDULER_ENABLED === "false",
    apiKey: process.env.PAPERCLIP_API_KEY,
  });
  process.stdout.write(`${JSON.stringify({
    companyId: result.company.id,
    agentIds: result.agents.map((agent) => ({ name: agent.name, id: agent.id, status: agent.status })),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
