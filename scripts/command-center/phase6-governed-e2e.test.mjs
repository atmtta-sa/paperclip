import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExpectedRuns,
  assertPhase6ExecutionGate,
  assertSingleActiveAgent,
  buildPhase6Plan,
  withPausedAgent,
} from "./phase6-governed-e2e.mjs";

const workspaces = {
  lead: "/tmp/paperclip-phase6/lead",
  orp: "/tmp/paperclip-phase6/orp",
  whattsi: "/tmp/paperclip-phase6/whattsi",
  codex: "/tmp/paperclip-phase6/codex",
  hermes: "/tmp/paperclip-phase6/hermes",
};
const verifyWorkspaces = () => workspaces;

const safeGate = {
  allowApply: true,
  providerApproved: true,
  schedulerDisabled: true,
  baseUrl: "http://127.0.0.1:3120",
  workspaces,
  disposableRoot: "/tmp/paperclip-phase6",
  verifyWorkspaces,
};

test("dry-run plan permits no provider execution", () => {
  const plan = buildPhase6Plan({ workspaces, disposableRoot: "/tmp/paperclip-phase6" });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.providerExecution, false);
  assert.deepEqual(plan.sequence, ["hermes", "codex"]);
  assert.equal(plan.maxConcurrentAgents, 1);
});

test("execution requires apply, provider approval, and disabled scheduler", () => {
  assert.throws(
    () => assertPhase6ExecutionGate({ ...safeGate, allowApply: false }),
    /explicit apply/,
  );
  assert.throws(
    () => assertPhase6ExecutionGate({ ...safeGate, providerApproved: false }),
    /provider approval/,
  );
  assert.throws(
    () => assertPhase6ExecutionGate({ ...safeGate, schedulerDisabled: false }),
    /scheduler.*disabled/i,
  );
});

test("execution rejects remote or credential-bearing API URLs before workspace validation", () => {
  let verifications = 0;
  const verify = () => { verifications += 1; return workspaces; };

  assert.throws(
    () => assertPhase6ExecutionGate({ ...safeGate, baseUrl: "https://paperclip.example", verifyWorkspaces: verify }),
    /credential-free loopback/,
  );
  assert.throws(
    () => assertPhase6ExecutionGate({ ...safeGate, baseUrl: "http://user:pass@127.0.0.1:3120", verifyWorkspaces: verify }),
    /credential-free loopback/,
  );
  assert.equal(verifications, 0);
});

test("execution delegates canonical Git-root containment to the Phase 5 guard", () => {
  let received = null;
  const verify = (actualWorkspaces, root) => {
    received = { actualWorkspaces, root };
    return actualWorkspaces;
  };

  assertPhase6ExecutionGate({ ...safeGate, verifyWorkspaces: verify });

  assert.deepEqual(received, {
    actualWorkspaces: workspaces,
    root: "/tmp/paperclip-phase6",
  });
});

test("only the selected agent may be active", () => {
  assert.doesNotThrow(() => assertSingleActiveAgent([
    { id: "hermes", status: "running" },
    { id: "codex", status: "paused" },
  ], "hermes"));
  assert.throws(() => assertSingleActiveAgent([
    { id: "hermes", status: "running" },
    { id: "codex", status: "idle" },
  ], "hermes"), /unexpected active agent codex/);
  assert.throws(() => assertSingleActiveAgent([
    { id: "hermes", status: "running" },
    { id: "codex", status: "active" },
  ], "hermes"), /unexpected active agent codex/);
});

test("unexpected extra runs fail closed", () => {
  const expected = [{ id: "run-1", status: "succeeded" }];
  assert.doesNotThrow(() => assertExpectedRuns(expected, new Set(["run-1"])));
  assert.throws(
    () => assertExpectedRuns([...expected, { id: "run-2", status: "running" }], new Set(["run-1"])),
    /unexpected run run-2/,
  );
});

test("selected agent is paused when bounded execution fails", async () => {
  const calls = [];

  await assert.rejects(
    withPausedAgent({
      agentId: "hermes",
      resume: async (id) => calls.push(`resume:${id}`),
      execute: async () => { calls.push("execute"); throw new Error("failed run"); },
      pause: async (id) => calls.push(`pause:${id}`),
    }),
    /failed run/,
  );
  assert.deepEqual(calls, ["resume:hermes", "execute", "pause:hermes"]);
});
