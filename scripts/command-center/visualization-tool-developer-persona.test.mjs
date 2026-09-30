import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = readFileSync(
  new URL("./visualization-tool-developer/AGENTS.md", import.meta.url),
  "utf8",
);

test("Visualization Tool Developer keeps role-specific architecture capability", () => {
  const requiredTerms = [
    "Python AST/static analysis",
    "normalized architecture graph models",
    "stable node and edge identities",
    "Dash Cytoscape",
    "React Flow",
    "static-analysis limitations",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("Visualization Tool Developer delegates generic execution policy to its owners", () => {
  assert.ok(Buffer.byteLength(instructions, "utf8") < 4_500);
  const removedSections = [
    "Bounded execution discipline",
    "Test-first execution",
    "Cost and lifecycle controls",
    "Completion report",
  ];

  for (const section of removedSections) assert.doesNotMatch(instructions, new RegExp(section, "i"));
  assert.match(instructions, /Repository-local instructions remain authoritative/i);
  assert.match(instructions, /Team Lead retains .* final acceptance authority/i);
});
