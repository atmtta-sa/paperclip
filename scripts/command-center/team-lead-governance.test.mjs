import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PROJECT_WATCHDOG_INSTRUCTIONS,
  authorizeTeamLeadAction,
  buildProjectWatchdogRequest,
  decideStoppedWork,
} from "./team-lead-governance.mjs";

const passingEvidence = [
  { gate: "focused_tests", status: "passed", detail: "12 passed" },
  { gate: "quality", status: "passed", detail: "typecheck and build passed" },
];

const teamLeadInstructions = readFileSync(
  new URL("./team-lead/AGENTS.md", import.meta.url),
  "utf8",
);

function stoppedWork(overrides = {}) {
  return {
    developerTaskId: "task-1",
    requiredGates: ["focused_tests", "quality"],
    evidenceReports: passingEvidence,
    remainingAcceptanceCriteria: [],
    pendingWait: null,
    projectFinalTask: false,
    uat: null,
    nazApproval: null,
    ...overrides,
  };
}

test("returns an incomplete slice to the same developer", () => {
  assert.deepEqual(
    decideStoppedWork(stoppedWork({ remainingAcceptanceCriteria: ["Arabic browser UAT"] })),
    {
      action: "resume_developer",
      developerTaskId: "task-1",
      reasons: ["remaining acceptance criterion: Arabic browser UAT"],
    },
  );
});

test("returns precise corrections for missing, failed, or duplicate evidence", () => {
  const decision = decideStoppedWork(stoppedWork({
    requiredGates: ["focused_tests", "quality", "security"],
    evidenceReports: [
      { gate: "focused_tests", status: "failed", detail: "1 failed" },
      { gate: "quality", status: "passed", detail: "typecheck passed" },
      { gate: "quality", status: "passed", detail: "duplicate report" },
    ],
  }));

  assert.deepEqual(decision, {
    action: "request_corrections",
    developerTaskId: "task-1",
    reasons: [
      "failed gate focused_tests: 1 failed",
      "duplicate evidence for gate quality",
      "missing gate security",
    ],
  });
});

test("does not wake a developer when a first-class waiting path exists", () => {
  assert.deepEqual(
    decideStoppedWork(stoppedWork({ pendingWait: { kind: "approval", id: "approval-1" } })),
    { action: "honor_wait", wait: { kind: "approval", id: "approval-1" } },
  );
});

test("releases the next task after a non-final task passes", () => {
  assert.deepEqual(decideStoppedWork(stoppedWork()), {
    action: "release_next_task",
    completedTaskId: "task-1",
  });
});

test("requires a developer UAT handoff at project end", () => {
  assert.deepEqual(
    decideStoppedWork(stoppedWork({ projectFinalTask: true })),
    { action: "request_uat_handoff", developerTaskId: "task-1" },
  );
});

test("requires Team Lead verification of the URL and test steps", () => {
  assert.deepEqual(
    decideStoppedWork(stoppedWork({
      projectFinalTask: true,
      uat: { url: "http://127.0.0.1:8000/en/project", steps: ["Open the page"], leadVerified: false },
    })),
    { action: "verify_project_uat", developerTaskId: "task-1" },
  );
});

test("waits for Naz after Team Lead verifies project UAT", () => {
  assert.deepEqual(
    decideStoppedWork(stoppedWork({
      projectFinalTask: true,
      uat: { url: "http://127.0.0.1:8000/en/project", steps: ["Open the page"], leadVerified: true },
    })),
    {
      action: "await_naz_approval",
      uat: { url: "http://127.0.0.1:8000/en/project", steps: ["Open the page"] },
    },
  );
});

test("unlocks the next project only after explicit successful-test approval", () => {
  assert.deepEqual(
    decideStoppedWork(stoppedWork({
      projectFinalTask: true,
      uat: { url: "http://127.0.0.1:8000/en/project", steps: ["Open the page"], leadVerified: true },
      nazApproval: { status: "accepted", outcome: "testing_successful" },
    })),
    { action: "release_next_project", completedTaskId: "task-1" },
  );
});

test("builds a project watchdog request assigned to Team Lead", () => {
  assert.deepEqual(buildProjectWatchdogRequest("00000000-0000-4000-8000-000000000001"), {
    agentId: "00000000-0000-4000-8000-000000000001",
    instructions: PROJECT_WATCHDOG_INSTRUCTIONS,
  });
  assert.match(PROJECT_WATCHDOG_INSTRUCTIONS, /every stopped task subtree/i);
  assert.match(PROJECT_WATCHDOG_INSTRUCTIONS, /same developer/i);
  assert.match(PROJECT_WATCHDOG_INSTRUCTIONS, /Naz/i);
});

test("fails closed for protected repositories, providers, operations, and production", () => {
  for (const action of [
    "bind_protected_repository",
    "invoke_provider_or_spend",
    "push_merge_or_deploy",
    "activate_production",
  ]) {
    assert.deepEqual(authorizeTeamLeadAction({ action, scope: "orp" }), {
      allowed: false,
      reason: `explicit bounded approval required for ${action}`,
    });
  }
});

test("rejects mismatched or unbounded approvals", () => {
  assert.equal(authorizeTeamLeadAction({
    action: "activate_production",
    scope: "orp",
    approval: { status: "accepted", action: "push_merge_or_deploy", scope: "orp", bounded: true },
  }).allowed, false);
  assert.equal(authorizeTeamLeadAction({
    action: "activate_production",
    scope: "orp",
    approval: { status: "accepted", action: "activate_production", scope: "orp", bounded: false },
  }).allowed, false);
});

test("fails closed for unknown actions and missing approval scope", () => {
  assert.deepEqual(authorizeTeamLeadAction({ action: "activate_prodution", scope: "orp" }), {
    allowed: false,
    reason: "unknown Team Lead action activate_prodution",
  });
  assert.deepEqual(authorizeTeamLeadAction({
    action: "activate_production",
    approval: { status: "accepted", action: "activate_production", bounded: true },
  }), {
    allowed: false,
    reason: "explicit bounded approval required for activate_production",
  });
});

test("accepts only an exact bounded approval for the requested action and scope", () => {
  assert.deepEqual(authorizeTeamLeadAction({
    action: "activate_production",
    scope: "orp-staging-to-production",
    approval: {
      status: "accepted",
      action: "activate_production",
      scope: "orp-staging-to-production",
      bounded: true,
    },
  }), { allowed: true, reason: "exact bounded approval present" });
});

test("Team Lead instructions encode event, worker, UAT, and safety governance", () => {
  const requiredTerms = [
    "task_watchdog_stopped_subtree",
    "same developer",
    "working test URL",
    "testing_successful",
    "protected repository",
    "provider",
    "spend",
    "production",
    "ORP Developer",
    "Whattsi Developer",
    "Codex Agent",
    "Hermes Agent",
  ];
  for (const term of requiredTerms) assert.match(teamLeadInstructions, new RegExp(term, "i"));
});
