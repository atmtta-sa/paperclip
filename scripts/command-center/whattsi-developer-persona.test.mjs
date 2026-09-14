import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = readFileSync(
  new URL("./whattsi-developer/AGENTS.md", import.meta.url),
  "utf8",
);
const organizationDocs = readFileSync(
  new URL("../../docs/command-center/TEAM_AND_ADAPTERS.md", import.meta.url),
  "utf8",
);

test("Whattsi Developer instructions encode ownership and current project context", () => {
  const requiredTerms = [
    "Whattsi Developer",
    "Team Lead",
    "Paperclip skill",
    "same heartbeat",
    "same assigned task",
    "README.md",
    "docs/requirements.md",
    "docs/tech-stack.md",
    "docs/public-launch-readiness.md",
    "docs/security-assessment.md",
    "docs/service-ownership.md",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("Whattsi Developer instructions preserve architecture and data boundaries", () => {
  const requiredTerms = [
    "FastAPI",
    "PostgreSQL",
    "SQLAlchemy",
    "Alembic",
    "provider integration",
    "lookup/search logic",
    "response formatting",
    "state mutation",
    "tenant isolation",
    "idempotency",
    "Cloudflare Access",
    "Meta WhatsApp Cloud API",
    "Moyasar",
    "English",
    "Arabic",
    "RTL",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("Whattsi Developer instructions enforce safe testing and external boundaries", () => {
  const requiredTerms = [
    "failing test",
    "python3",
    "pytest",
    "Ruff",
    "Radon C",
    "Bandit",
    "isolated disposable PostgreSQL",
    "never the live database",
    "real WhatsApp",
    "Cloudflare tunnel",
    "commit",
    "push",
    "merge",
    "deploy",
    "database migration",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("Whattsi Developer instructions preserve launch evidence semantics", () => {
  for (const term of ["Implemented", "Baseline", "Activated", "Operationally verified"]) {
    assert.match(instructions, new RegExp(term, "i"));
  }
  assert.match(instructions, /local tests alone.*COMPLETE/is);
  assert.match(instructions, /public URL/i);
  assert.match(instructions, /monitoring/i);
  assert.match(instructions, /rollback/i);
});

test("organization docs describe the Whattsi Developer persona boundary", () => {
  assert.match(organizationDocs, /## Whattsi Developer persona/);
  assert.match(organizationDocs, /scripts\/command-center\/whattsi-developer\/AGENTS\.md/);
  assert.match(organizationDocs, /does not authorize binding.*real Whattsi/i);
});
