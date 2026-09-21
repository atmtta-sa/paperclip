import assert from "node:assert/strict";
import test from "node:test";

import {
  TEAM_LEAD_NOTIFICATION_CHANNELS,
  decideStoppedWork,
} from "./team-lead-governance.mjs";

const passingEvidence = [
  { gate: "focused_tests", status: "passed", detail: "12 passed" },
  { gate: "quality", status: "passed", detail: "typecheck and build passed" },
];

function stoppedWork(overrides = {}) {
  return {
    developerTaskId: "task-1",
    requiredGates: ["focused_tests", "quality"],
    evidenceReports: passingEvidence,
    remainingAcceptanceCriteria: [],
    pendingWait: null,
    projectFinalTask: false,
    uat: null,
    uatPublication: null,
    escalationPublication: null,
    nazApproval: null,
    ...overrides,
  };
}

test("escalates a genuine human blocker before honoring its wait", () => {
  const pendingWait = {
    kind: "approval",
    id: "approval-1",
    requiresNazAction: true,
    summary: "Authorize bounded read-only repository recovery",
  };
  assert.deepEqual(decideStoppedWork(stoppedWork({ pendingWait })), {
    action: "publish_escalation",
    channel: "#escaltions",
    wait: pendingWait,
  });
});

test("honors a genuine human blocker only after acknowledged escalation delivery", () => {
  const pendingWait = {
    kind: "approval",
    id: "approval-1",
    requiresNazAction: true,
    summary: "Authorize bounded read-only repository recovery",
  };
  assert.deepEqual(decideStoppedWork(stoppedWork({
    pendingWait,
    escalationPublication: {
      channel: "#escaltions",
      status: "delivered",
      receiptId: "slack-receipt-1",
    },
  })), { action: "honor_wait", wait: pendingWait });
});

test("publishes verified project UAT to Q&A before waiting for Naz", () => {
  const uat = {
    url: "http://127.0.0.1:8000/en/project",
    steps: ["Open the page"],
    leadVerified: true,
  };
  assert.deepEqual(decideStoppedWork(stoppedWork({ projectFinalTask: true, uat })), {
    action: "publish_uat_handoff",
    channel: "q-and-a",
    uat: { url: uat.url, steps: uat.steps },
  });
});

test("waits for Naz only after acknowledged Q&A delivery", () => {
  const uat = {
    url: "http://127.0.0.1:8000/en/project",
    steps: ["Open the page"],
    leadVerified: true,
  };
  assert.deepEqual(decideStoppedWork(stoppedWork({
    projectFinalTask: true,
    uat,
    uatPublication: {
      channel: "q-and-a",
      status: "delivered",
      receiptId: "slack-receipt-2",
    },
  })), {
    action: "await_naz_approval",
    uat: { url: uat.url, steps: uat.steps },
  });
});

test("uses the configured Slack destinations", () => {
  assert.deepEqual(TEAM_LEAD_NOTIFICATION_CHANNELS, {
    uat: "q-and-a",
    escalation: "#escaltions",
  });
});
