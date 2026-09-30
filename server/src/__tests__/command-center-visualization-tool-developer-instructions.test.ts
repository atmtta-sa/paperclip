import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const instructionsPath = resolve(
  process.cwd(),
  "scripts/command-center/visualization-tool-developer/AGENTS.md",
);

async function instructions() {
  return readFile(instructionsPath, "utf8");
}

describe("Visualization Tool Developer persona ownership", () => {
  it("keeps only role-specific scope, authority, escalation, and capabilities", async () => {
    const text = await instructions();

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(4_500);
    expect(text).toContain("## Charter");
    expect(text).toContain("## Authority limits");
    expect(text).toContain("## Escalation");
    expect(text).toContain("## Architecture laws");
    expect(text).toContain("## Role-specific delivery");
  });

  it("does not duplicate generic execution owners", async () => {
    const text = await instructions();

    for (const removedHeading of [
      "## Required start gate",
      "## Bounded execution discipline",
      "## Project boundaries",
      "## Test-first execution",
      "## Cost and lifecycle controls",
      "## Completion report",
    ]) {
      expect(text).not.toContain(removedHeading);
    }
  });
});
