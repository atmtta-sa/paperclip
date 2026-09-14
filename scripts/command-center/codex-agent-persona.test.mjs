import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = readFileSync(
  new URL("./codex-agent/AGENTS.md", import.meta.url),
  "utf8",
);
const organizationDocs = readFileSync(
  new URL("../../docs/command-center/TEAM_AND_ADAPTERS.md", import.meta.url),
  "utf8",
);

test("Codex Agent is a project-neutral software engineer with task-selected modes", () => {
  for (const term of [
    "Codex Agent",
    "Atmmta SA",
    "Team Lead",
    "Implementation",
    "Independent review",
    "Diagnosis",
    "Verification",
    "Refactoring",
    "repository-local AGENTS.md",
  ]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /mode.*assigned task/is);
  assert.match(instructions, /no standing project ownership/i);
});

test("Codex Agent remains bounded and cannot displace accountable roles", () => {
  for (const term of [
    "exact assigned repository",
    "exact approved worktree",
    "acceptance criteria",
    "ORP Developer",
    "Whattsi Developer",
    "final acceptance",
    "commit",
    "push",
    "merge",
    "deploy",
    "provider",
    "live data",
  ]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /do not select.*work/i);
  assert.match(instructions, /must not approve.*own implementation/i);
  assert.match(instructions, /Team Lead.*final acceptance/is);
});

test("Codex Agent avoids unnecessary provider runs", () => {
  assert.match(instructions, /paused by default/i);
  assert.match(instructions, /scheduled heartbeat.*disabled/i);
  assert.match(instructions, /one bounded task/i);
  assert.match(instructions, /do not poll/i);
  assert.match(instructions, /do not create.*work.*keep.*active/is);
  assert.match(instructions, /finish.*verdict.*exit/is);
});

test("Codex Agent applies mode-specific mutation rules", () => {
  assert.match(instructions, /independent review.*read-only/is);
  assert.match(instructions, /diagnosis.*reproduce/is);
  assert.match(instructions, /verification.*actual commands/is);
  assert.match(instructions, /refactoring.*preserv.*behavior/is);
  assert.match(instructions, /implementation.*failing test/is);
});

test("organization docs describe Codex ownership and exceptional dispatch", () => {
  assert.match(organizationDocs, /## Codex Software Engineer persona/);
  assert.match(organizationDocs, /scripts\/command-center\/codex-agent\/AGENTS\.md/);
  assert.match(organizationDocs, /project developers remain.*default implementers/is);
  assert.match(organizationDocs, /does not run automatically/i);
  assert.match(organizationDocs, /high-risk|difficult diagnosis|independent verification/i);
});
