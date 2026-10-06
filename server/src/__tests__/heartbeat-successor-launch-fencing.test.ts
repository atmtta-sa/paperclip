import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const heartbeatSourceUrl = new URL("../services/heartbeat.ts", import.meta.url);

describe("automatic successor launch fencing wiring", () => {
  it("passes exact predecessor lineage to both native and legacy budget admission", async () => {
    const source = await readFile(heartbeatSourceUrl, "utf8");
    const lineageBindings = source.match(/previousRunId:\s*run\.retryOfRunId/g) ?? [];

    expect(lineageBindings).toHaveLength(2);
  });

  it("routes every automatic successor through the final current-run dispatch gate", async () => {
    const source = await readFile(heartbeatSourceUrl, "utf8");

    expect(source).toContain("const requiresCurrentDispatchGate = Boolean(run.retryOfRunId)");
  });
});
