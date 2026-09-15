import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildTeamPlan } from "./bootstrap-phase5-team.mjs";

const disposableRoot = "/tmp/paperclip-command-center-shared-knowledge";
const workspaces = {
  lead: `${disposableRoot}/lead`,
  orp: `${disposableRoot}/orp`,
  whattsi: `${disposableRoot}/whattsi`,
  codex: `${disposableRoot}/codex`,
  hermes: `${disposableRoot}/hermes`,
};

const personaPaths = [
  "./team-lead/AGENTS.md",
  "./orp-developer/AGENTS.md",
  "./whattsi-developer/AGENTS.md",
  "./hermes-agent/AGENTS.md",
];

const personas = personaPaths.map((path) => ({
  path,
  content: readFileSync(new URL(path, import.meta.url), "utf8"),
}));

const organizationDocs = readFileSync(
  new URL("../../docs/command-center/TEAM_AND_ADAPTERS.md", import.meta.url),
  "utf8",
);
const teamLeadInstructions = readFileSync(
  new URL("./team-lead/AGENTS.md", import.meta.url),
  "utf8",
);
const codexInstructions = readFileSync(
  new URL("./codex-agent/AGENTS.md", import.meta.url),
  "utf8",
);

test("all Hermes workers use one shared OpenViking peer", () => {
  const plan = buildTeamPlan({ workspaces, disposableRoot });
  const hermesWorkers = plan.agents.filter((agent) => agent.adapterType === "hermes_local");
  const codex = plan.agents.find((agent) => agent.adapterType === "codex_local");

  assert.equal(hermesWorkers.length, 4);
  assert.ok(codex);

  for (const worker of hermesWorkers) {
    const toolsets = new Set(worker.adapterConfig.toolsets.split(","));
    assert.ok(toolsets.has("memory"), `${worker.name} must enable Hermes memory tools`);
    assert.equal(worker.adapterConfig.env.OPENVIKING_ACCOUNT, "hermes");
    assert.equal(worker.adapterConfig.env.OPENVIKING_USER, "yoga");
    assert.equal(worker.adapterConfig.env.OPENVIKING_AGENT, "hermes");
    assert.equal(
      worker.adapterConfig.env.HERMES_OPENVIKING_ALLOWED_TOOLS,
      "viking_search,viking_read,viking_browse,viking_remember",
    );
    assert.equal(worker.adapterConfig.env.HERMES_OPENVIKING_CAPTURE_TURNS, "0");
    assert.equal(worker.adapterConfig.env.HERMES_OPENVIKING_MIRROR_MEMORY_WRITES, "0");
  }
  assert.equal(codex.adapterConfig.env?.OPENVIKING_ACCOUNT, undefined);
});

test("all Hermes personas define retrieval-first and controlled contribution rules", () => {
  for (const { path, content } of personas) {
    assert.match(content, /## Shared OpenViking knowledge/);
    assert.match(content, /search.*OpenViking.*before.*broad/is, path);
    assert.match(content, /viking:\/\//, path);
    assert.match(content, /verified.*reusable/is, path);
    assert.match(content, /Contributor:\s+[^`,]+/i, path);
    assert.match(content, /source.*freshness/is, path);
    assert.match(content, /raw (?:conversation|transcript)s?/i, path);
    assert.match(content, /credentials|secrets/i, path);
    assert.match(content, /Paperclip.*(?:tasks|assignments).*Git.*(?:code|source)/is, path);
  }
});

test("Codex receives relevant OpenViking context indirectly through Team Lead", () => {
  assert.match(
    teamLeadInstructions,
    /when.*Codex.*relevant.*search OpenViking.*include only.*necessary excerpts.*`viking:\/\/`.*no direct OpenViking access/is,
  );
  assert.match(
    codexInstructions,
    /no direct OpenViking access.*use only.*excerpts.*`viking:\/\/`.*Paperclip task/is,
  );
});

test("organization docs keep OpenViking knowledge subordinate to system authorities", () => {
  assert.match(organizationDocs, /## Shared OpenViking knowledge/);
  assert.match(organizationDocs, /four `hermes_local` workers/i);
  assert.match(organizationDocs, /Paperclip.*tasks.*approvals/is);
  assert.match(organizationDocs, /Git.*source of truth/is);
  assert.match(organizationDocs, /Codex.*bounded task context/is);
});
