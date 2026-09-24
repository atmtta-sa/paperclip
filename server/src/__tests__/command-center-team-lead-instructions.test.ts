import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const instructionsPath = resolve(
  process.cwd(),
  "scripts/command-center/team-lead/AGENTS.md",
);

async function instructions() {
  return readFile(instructionsPath, "utf8");
}

describe("Command Center Team Lead Slack contract", () => {
  it("keeps ordinary Slack conversation out of Paperclip task logs", async () => {
    const text = await instructions();

    expect(text).toContain(
      "Do not create a Paperclip task unless Naz explicitly asks you to create a task",
    );
    expect(text).toContain(
      "Never copy Slack conversation text into task descriptions, comments, or dashboard activity",
    );
    expect(text).toContain(
      "Treat status questions as read-only",
    );
  });

  it("reports the live configured developer provider instead of stale run attribution", async () => {
    const text = await instructions();

    expect(text).toContain(
      "Read each developer's current adapter provider and model configuration before reporting a provider blocker",
    );
    expect(text).toContain(
      "ORP Developer and Whattsi Developer currently use Kimi K3",
    );
    expect(text).toContain(
      "GET /api/companies/$PAPERCLIP_COMPANY_ID/agents",
    );
    expect(text).toContain(
      "report adapterConfig.provider and adapterConfig.model verbatim",
    );
    expect(text).toContain(
      "Never replace those current values with a provider or model named only in historical run output, comments, or errors",
    );
  });
});
