import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = readFileSync(
  new URL("./orp-developer/AGENTS.md", import.meta.url),
  "utf8",
);
const organizationDocs = readFileSync(
  new URL("../../docs/command-center/TEAM_AND_ADAPTERS.md", import.meta.url),
  "utf8",
);

test("ORP Developer instructions encode execution and reporting ownership", () => {
  const requiredTerms = [
    "ORP Developer",
    "Team Lead",
    "Paperclip skill",
    "same heartbeat",
    "same assigned task",
    "ACTIVE_TASKS.md",
    "SESSION_HANDOFF.md",
    "CURRENT_STATE.md",
    "TENANT_JOURNEY_SPEC.md",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("ORP Developer instructions preserve architecture and product laws", () => {
  const requiredTerms = [
    "thin orchestration",
    "provider logic",
    "response formatting",
    "intent detection",
    "state mutation",
    "PostgreSQL",
    "tenant isolation",
    "idempotency",
    "English",
    "Arabic",
    "RTL",
    "verbatim",
    "conversation-control/operator queue",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("ORP Developer instructions enforce tests, evidence, and approval boundaries", () => {
  const requiredTerms = [
    "failing test",
    "Ruff",
    "pytest",
    "Radon C",
    "Bandit",
    "isolated disposable PostgreSQL",
    "commit",
    "push",
    "merge",
    "deploy",
    "provider configuration",
    "database migration",
    "live-data",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("organization docs describe the ORP Developer persona boundary", () => {
  assert.match(organizationDocs, /## ORP Developer persona/);
  assert.match(organizationDocs, /scripts\/command-center\/orp-developer\/AGENTS\.md/);
  assert.match(organizationDocs, /does not authorize binding.*real ORP/i);
});
