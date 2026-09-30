import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const instructions = readFileSync(
  new URL("./visualization-tool-developer/AGENTS.md", import.meta.url),
  "utf8",
);

test("Visualization Tool Developer uses bounded targeted discovery before implementation", () => {
  const requiredTerms = [
    "Bounded execution discipline",
    "predecessor evidence",
    "path-scoped",
    "finite result limit",
    "large handoff/history files wholesale",
    "smallest focused failing test",
    "durable checkpoint",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});

test("Visualization Tool Developer keeps quality and authorization gates", () => {
  const requiredTerms = [
    "pytest",
    "Ruff",
    "Radon",
    "Bandit",
    "commit",
    "push",
    "deployment",
    "database migration",
    "live-data mutation",
  ];

  for (const term of requiredTerms) assert.match(instructions, new RegExp(term, "i"));
});
