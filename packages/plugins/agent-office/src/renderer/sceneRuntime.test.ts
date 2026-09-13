import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "sceneRuntime.ts");

describe("Agent Office Three.js runtime compatibility", () => {
  it("avoids removed or deprecated Three.js timing and shadow APIs", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("THREE.Clock");
    expect(source).not.toContain("PCFSoftShadowMap");
    expect(source).toContain("performance.now()");
    expect(source).toContain("THREE.PCFShadowMap");
  });
});
