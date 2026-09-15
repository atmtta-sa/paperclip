import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = readFileSync(
  new URL("./hermes-agent/AGENTS.md", import.meta.url),
  "utf8",
);
const organizationDocs = readFileSync(
  new URL("../../docs/command-center/TEAM_AND_ADAPTERS.md", import.meta.url),
  "utf8",
);

test("Hermes Agent is an operations and research worker running on Hermes", () => {
  for (const term of [
    "Hermes Operations & Research Agent",
    "Atmmta SA",
    "Team Lead",
    "Hermes runtime",
    "source-grounded research",
    "browser verification",
    "operational diagnostics",
    "monitoring",
    "messaging",
  ]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /one explicitly assigned Paperclip task/i);
});

test("Hermes Agent does not overlap product delivery, Codex, or Team Lead", () => {
  for (const term of [
    "ORP Developer",
    "Whattsi Developer",
    "Codex Agent",
    "Team Lead",
    "product code",
    "final acceptance",
    "worker governance",
  ]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /do not implement.*product/i);
  assert.match(instructions, /do not assign.*worker/i);
  assert.match(instructions, /do not approve.*delivery/i);
});

test("Hermes Agent is task-scoped, evidence-first, and cost bounded", () => {
  for (const term of [
    "exact scope",
    "authoritative source",
    "citations",
    "commands",
    "exit codes",
    "screenshots",
    "paused by default",
    "scheduled heartbeat",
    "do not poll",
    "one bounded task",
  ]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /do not invent.*evidence/i);
  assert.match(instructions, /finish.*report.*exit/is);
});

test("Hermes Agent protects external and operational boundaries", () => {
  for (const term of [
    "commit",
    "push",
    "merge",
    "deploy",
    "provider",
    "spending",
    "production",
    "live data",
    "external message",
    "credentials",
  ]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /separate approval/i);
  assert.match(instructions, /read-only by default/i);
});

test("organization docs describe Hermes runtime and persona boundary", () => {
  assert.match(organizationDocs, /## Hermes Operations & Research persona/);
  assert.match(organizationDocs, /scripts\/command-center\/hermes-agent\/AGENTS\.md/);
  assert.match(organizationDocs, /Hermes is the runtime/i);
  assert.match(organizationDocs, /does not own product implementation/i);
  assert.match(organizationDocs, /does not run automatically/i);
});
