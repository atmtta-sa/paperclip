#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PROJECT_WATCHDOG_INSTRUCTIONS,
  buildProjectWatchdogRequest,
} from "./team-lead-governance.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value;
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
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof payload?.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`${method} ${url} failed with ${response.status}${detail}`);
  }
  return payload;
}

function exactWatchdog(watchdog, rootIssueId, teamLeadAgentId) {
  return Boolean(
    watchdog &&
    watchdog.issueId === rootIssueId &&
    watchdog.watchdogAgentId === teamLeadAgentId &&
    watchdog.status === "active" &&
    watchdog.instructions === PROJECT_WATCHDOG_INSTRUCTIONS,
  );
}

export async function ensureProjectRootWatchdog({
  baseUrl,
  rootIssueId,
  teamLeadAgentId,
  apiKey,
  fetchImpl = globalThis.fetch,
}) {
  const root = apiRoot(baseUrl);
  const issueId = requiredUuid(rootIssueId, "root issue id");
  const agentId = requiredUuid(teamLeadAgentId, "Team Lead agent id");
  const url = `${root}/issues/${issueId}/watchdog`;
  const existing = await requestJson(fetchImpl, url, { apiKey });
  if (exactWatchdog(existing, issueId, agentId)) {
    return { action: "unchanged", watchdog: existing };
  }

  await requestJson(fetchImpl, url, {
    method: "PUT",
    body: buildProjectWatchdogRequest(agentId),
    apiKey,
  });
  const persisted = await requestJson(fetchImpl, url, { apiKey });
  if (!exactWatchdog(persisted, issueId, agentId)) {
    throw new Error(`watchdog read-back verification failed for root issue ${issueId}`);
  }
  return { action: existing ? "updated" : "created", watchdog: persisted };
}

export async function ensureProjectRootWatchdogs({ rootIssueIds, ...options }) {
  if (!Array.isArray(rootIssueIds) || rootIssueIds.length === 0) {
    throw new Error("at least one project root issue id is required");
  }
  const results = [];
  for (const rootIssueId of rootIssueIds) {
    results.push(await ensureProjectRootWatchdog({ ...options, rootIssueId }));
  }
  return results;
}

async function main() {
  const rootIssueIds = (process.env.PAPERCLIP_PROJECT_ROOT_ISSUE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const preview = {
    baseUrl: process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100",
    rootIssueIds,
    teamLeadAgentId: process.env.PAPERCLIP_TEAM_LEAD_AGENT_ID ?? null,
  };
  if (!process.argv.includes("--apply")) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }
  if (process.env.PAPERCLIP_CONTINUITY_APPLY !== "1") {
    throw new Error("PAPERCLIP_CONTINUITY_APPLY=1 is required with --apply");
  }
  const results = await ensureProjectRootWatchdogs({
    ...preview,
    apiKey: process.env.PAPERCLIP_API_KEY,
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
