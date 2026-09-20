import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_MODELS,
  ERROR_MONSTER_MODEL,
  errorMonsterAssetUrl,
  FURNITURE_MODELS,
  modelAssetUrl,
} from "./assets.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.join(packageRoot, "assets/upstream/kenney");
const monsterRoot = path.join(packageRoot, "assets/upstream/kenney-blocky");

function hasGlbHeader(filePath: string): boolean {
  return readFileSync(filePath).subarray(0, 4).toString("ascii") === "glTF";
}

function hasPngHeader(filePath: string): boolean {
  return readFileSync(filePath).subarray(1, 4).toString("ascii") === "PNG";
}

describe("bounded upstream Agent Office asset intake", () => {
  it("declares only the selected furniture and character models", () => {
    expect(FURNITURE_MODELS).toHaveLength(18);
    expect(CHARACTER_MODELS).toHaveLength(12);
    expect(modelAssetUrl("installed-plugin-id", "desk")).toBe(
      "/_plugins/installed-plugin-id/ui/assets/kenney/desk.glb",
    );
  });

  it("retains valid model binaries and their source licenses", () => {
    const models = [...FURNITURE_MODELS, ...CHARACTER_MODELS];
    expect(models.every((name) => hasGlbHeader(path.join(sourceRoot, `${name}.glb`)))).toBe(true);
    expect(readFileSync(path.join(sourceRoot, "licenses/Furniture-Kit-License.txt"), "utf8")).toContain("CC0");
    expect(readFileSync(path.join(sourceRoot, "licenses/Mini-Characters-License.txt"), "utf8")).toContain("CC0");
  });

  it("keeps the upstream error robot in a separate licensed asset namespace", () => {
    expect(ERROR_MONSTER_MODEL).toBe("error-robot");
    expect(errorMonsterAssetUrl("installed-plugin-id")).toBe(
      "/_plugins/installed-plugin-id/ui/assets/kenney-blocky/robot.glb",
    );
    expect(hasGlbHeader(path.join(monsterRoot, "robot.glb"))).toBe(true);
    expect(hasPngHeader(path.join(monsterRoot, "Textures/texture-d.png"))).toBe(true);
    expect(readFileSync(path.join(monsterRoot, "LICENSE.txt"), "utf8")).toContain("CC0");
  });
});
