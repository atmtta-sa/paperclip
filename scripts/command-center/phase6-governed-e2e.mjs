#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { buildTeamPlan } from "./bootstrap-phase5-team.mjs";
import { verifyDisposableGitWorkspaces } from "./phase5-workspace-guards.mjs";

const ACTIVE_AGENT_STATUSES = new Set(["active", "idle", "running"]);

function apiRoot(baseUrl) {
  const parsed = new URL(baseUrl);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("Paperclip API must use a credential-free loopback URL");
  }
  const normalized = parsed.href.replace(/\/+$/, "");
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

export function buildPhase6Plan({ workspaces, disposableRoot }) {
  const team = buildTeamPlan({ workspaces, disposableRoot });
  return {
    mode: "dry-run",
    providerExecution: false,
    schedulerRequiredState: "disabled",
    sequence: ["hermes", "codex"],
    maxConcurrentAgents: 1,
    team,
  };
}

export function assertPhase6ExecutionGate({
  allowApply,
  providerApproved,
  schedulerDisabled,
  baseUrl,
  workspaces,
  disposableRoot,
  verifyWorkspaces = verifyDisposableGitWorkspaces,
}) {
  if (allowApply !== true) throw new Error("explicit apply approval is required");
  if (providerApproved !== true) throw new Error("explicit provider approval is required");
  if (schedulerDisabled !== true) throw new Error("heartbeat scheduler must be disabled");
  const root = apiRoot(baseUrl);
  const verifiedWorkspaces = verifyWorkspaces(workspaces, disposableRoot);
  return { root, workspaces: verifiedWorkspaces };
}

export function assertSingleActiveAgent(agents, selectedAgentId) {
  for (const agent of agents) {
    if (agent.id !== selectedAgentId && ACTIVE_AGENT_STATUSES.has(agent.status)) {
      throw new Error(`unexpected active agent ${agent.id}`);
    }
  }
}

export function assertExpectedRuns(runs, expectedRunIds) {
  for (const run of runs) {
    if (!expectedRunIds.has(run.id)) throw new Error(`unexpected run ${run.id}`);
  }
}

export async function withPausedAgent({ agentId, resume, execute, pause }) {
  try {
    await resume(agentId);
    return await execute();
  } finally {
    await pause(agentId);
  }
}

function envWorkspaces() {
  return {
    lead: process.env.PAPERCLIP_PHASE6_LEAD_CWD,
    orp: process.env.PAPERCLIP_PHASE6_ORP_CWD,
    whattsi: process.env.PAPERCLIP_PHASE6_WHATTSI_CWD,
    codex: process.env.PAPERCLIP_PHASE6_CODEX_CWD,
    hermes: process.env.PAPERCLIP_PHASE6_HERMES_CWD,
  };
}

async function main() {
  const workspaces = envWorkspaces();
  const disposableRoot = process.env.PAPERCLIP_PHASE6_DISPOSABLE_ROOT;
  if (!process.argv.includes("--apply")) {
    process.stdout.write(`${JSON.stringify(buildPhase6Plan({ workspaces, disposableRoot }), null, 2)}\n`);
    return;
  }
  const gate = assertPhase6ExecutionGate({
    allowApply: process.env.PAPERCLIP_PHASE6_APPLY === "1",
    providerApproved: process.env.PAPERCLIP_PHASE6_PROVIDER_APPROVED === "1",
    schedulerDisabled: process.env.HEARTBEAT_SCHEDULER_ENABLED === "false",
    baseUrl: process.env.PAPERCLIP_API_URL ?? "",
    workspaces,
    disposableRoot,
  });
  process.stdout.write(`${JSON.stringify({ approved: true, ...gate }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
