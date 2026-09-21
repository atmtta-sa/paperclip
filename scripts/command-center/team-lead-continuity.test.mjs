import assert from "node:assert/strict";
import test from "node:test";

import { ensureProjectRootWatchdog } from "./team-lead-continuity.mjs";
import { PROJECT_WATCHDOG_INSTRUCTIONS } from "./team-lead-governance.mjs";

const rootIssueId = "00000000-0000-4000-8000-000000000001";
const teamLeadAgentId = "00000000-0000-4000-8000-000000000002";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test("creates a missing Team Lead watchdog and verifies the persisted result", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) return jsonResponse(200, null);
    return jsonResponse(200, {
      issueId: rootIssueId,
      watchdogAgentId: teamLeadAgentId,
      status: "active",
      instructions: PROJECT_WATCHDOG_INSTRUCTIONS,
    });
  };

  const result = await ensureProjectRootWatchdog({
    baseUrl: "http://127.0.0.1:3100",
    rootIssueId,
    teamLeadAgentId,
    apiKey: "test-key",
    fetchImpl,
  });

  assert.equal(result.action, "created");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    agentId: teamLeadAgentId,
    instructions: PROJECT_WATCHDOG_INSTRUCTIONS,
  });
  assert.equal(calls[1].options.headers.authorization, "Bearer test-key");
});

test("leaves an exact active Team Lead watchdog unchanged", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, {
      issueId: rootIssueId,
      watchdogAgentId: teamLeadAgentId,
      status: "active",
      instructions: PROJECT_WATCHDOG_INSTRUCTIONS,
    });
  };

  const result = await ensureProjectRootWatchdog({
    baseUrl: "http://127.0.0.1:3100/api",
    rootIssueId,
    teamLeadAgentId,
    fetchImpl,
  });

  assert.equal(result.action, "unchanged");
  assert.equal(calls, 1);
});

test("repairs a watchdog assigned to the wrong agent and verifies ownership", async () => {
  const wrongAgentId = "00000000-0000-4000-8000-000000000003";
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(200, {
        issueId: rootIssueId,
        watchdogAgentId: wrongAgentId,
        status: "active",
        instructions: "old",
      });
    }
    return jsonResponse(200, {
      issueId: rootIssueId,
      watchdogAgentId: teamLeadAgentId,
      status: "active",
      instructions: PROJECT_WATCHDOG_INSTRUCTIONS,
    });
  };

  const result = await ensureProjectRootWatchdog({
    baseUrl: "http://127.0.0.1:3100",
    rootIssueId,
    teamLeadAgentId,
    fetchImpl,
  });

  assert.equal(result.action, "updated");
  assert.equal(calls, 3);
});

test("fails when read-back does not prove active Team Lead ownership", async () => {
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "PUT") return jsonResponse(200, {});
    return jsonResponse(200, null);
  };

  await assert.rejects(
    ensureProjectRootWatchdog({
      baseUrl: "http://127.0.0.1:3100",
      rootIssueId,
      teamLeadAgentId,
      fetchImpl,
    }),
    /read-back verification failed/i,
  );
});

test("rejects non-loopback APIs and invalid identifiers before any request", async () => {
  const fetchImpl = async () => {
    throw new Error("must not be called");
  };
  await assert.rejects(
    ensureProjectRootWatchdog({
      baseUrl: "https://paperclip.example.com",
      rootIssueId,
      teamLeadAgentId,
      fetchImpl,
    }),
    /credential-free loopback/i,
  );
  await assert.rejects(
    ensureProjectRootWatchdog({
      baseUrl: "http://127.0.0.1:3100",
      rootIssueId: "COM-114",
      teamLeadAgentId,
      fetchImpl,
    }),
    /root issue id/i,
  );
});
