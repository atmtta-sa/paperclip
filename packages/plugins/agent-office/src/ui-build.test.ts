import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Agent Office browser bundle", () => {
  it("bundles Three.js and leaves only Paperclip-supported host imports", () => {
    const build = spawnSync(process.execPath, ["scripts/build-ui.mjs"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    expect(build.status, build.stderr || build.stdout).toBe(0);
    const output = readFileSync(path.join(packageRoot, "dist/ui/index.js"), "utf8");
    expect(output).toContain("AgentOfficeRenderer");
    expect(output).not.toMatch(/from\s+["']three["']/);
    expect(output).not.toMatch(/from\s+["']three\/examples/);
    expect(output).not.toContain("/cc/rooms");
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/kenney/desk.glb"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/kenney/Textures/colormap.png"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/licenses/Agent-Office-MIT.txt"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/kenney/licenses/Furniture-Kit-License.txt"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/kenney-blocky/robot.glb"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/kenney-blocky/Textures/texture-d.png"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/kenney-blocky/LICENSE.txt"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/tiny-treats/baked-goods/gltf/croissant.gltf"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/tiny-treats/baked-goods/gltf/croissant.bin"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/tiny-treats/baked-goods/LICENSE.txt"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/tiny-treats/charming-kitchen/gltf/fridge.gltf"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/tiny-treats/charming-kitchen/gltf/fridge.bin"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/ui/assets/tiny-treats/charming-kitchen/LICENSE.txt"))).toBe(true);
  });
});
