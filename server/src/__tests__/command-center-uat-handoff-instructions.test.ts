import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const developerContracts = [
  "orp-developer",
  "whattsi-developer",
  "visualization-tool-developer",
] as const;

async function instructions(persona: string) {
  return readFile(
    resolve(process.cwd(), `scripts/command-center/${persona}/AGENTS.md`),
    "utf8",
  );
}

describe("Command Center Naz UAT handoff contracts", () => {
  for (const persona of developerContracts) {
    it(`${persona} must produce a complete testable UAT package`, async () => {
      const text = await instructions(persona);

      expect(text).toContain("## Naz UAT handoff");
      expect(text).toContain("working test URL backed by the approved source/runtime");
      expect(text).toContain("exact source revision and runtime identity");
      expect(text).toContain("numbered test steps and expected results");
      expect(text).toContain("English and Arabic/RTL routes where applicable");
      expect(text).toContain("known limitations and rollback/cleanup notes");
      expect(text).toContain("Do not claim completion without this package");
    });
  }

  it("Team Lead governs Visualization and rejects incomplete UAT handoffs", async () => {
    const text = await instructions("team-lead");

    expect(text).toContain(
      "ORP Developer, Whattsi Developer, Visualization Tool Developer, Codex Agent, and Hermes Agent",
    );
    expect(text).toContain(
      "Reject a completion claim that omits any required UAT item",
    );
    expect(text).toContain(
      "return it to the same implementing developer on the same project",
    );
    expect(text).toContain(
      "Do not release the next project until Naz explicitly confirms `testing_successful`",
    );
  });
});
