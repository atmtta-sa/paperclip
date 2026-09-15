import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAKED_GOODS_MODELS,
  CHARMING_KITCHEN_MODELS,
  tinyTreatsAssetUrl,
  TINY_TREATS_COLLECTIONS,
} from "./tinyTreatsLibrary.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = path.join(packageRoot, "assets/upstream/tiny-treats");

function assertCompleteCollection(collection: "baked-goods" | "charming-kitchen", models: readonly string[]) {
  const root = path.join(sourceRoot, collection);
  expect(readFileSync(path.join(root, "LICENSE.txt"), "utf8")).toContain("Creative Commons Zero");
  expect(existsSync(path.join(root, "overview.png"))).toBe(true);
  expect(existsSync(path.join(root, "gltf/tiny_treats_texture_1.png"))).toBe(true);

  for (const model of models) {
    const definitionPath = path.join(root, "gltf", `${model}.gltf`);
    const bufferPath = path.join(root, "gltf", `${model}.bin`);
    expect(existsSync(definitionPath), `${collection}/${model}.gltf`).toBe(true);
    expect(existsSync(bufferPath), `${collection}/${model}.bin`).toBe(true);

    const definition = JSON.parse(readFileSync(definitionPath, "utf8")) as {
      buffers?: Array<{ uri?: string }>;
      images?: Array<{ uri?: string }>;
    };
    expect(definition.buffers?.map(({ uri }) => uri)).toContain(`${model}.bin`);
    expect(definition.images?.map(({ uri }) => uri)).toContain("tiny_treats_texture_1.png");
  }
}

describe("Tiny Treats asset library", () => {
  it("declares both complete FREE catalogs without assigning them to the live office", () => {
    expect(TINY_TREATS_COLLECTIONS).toEqual(["baked-goods", "charming-kitchen"]);
    expect(BAKED_GOODS_MODELS).toHaveLength(32);
    expect(CHARMING_KITCHEN_MODELS).toHaveLength(118);
  });

  it("builds installed-plugin URLs inside the separate Tiny Treats namespace", () => {
    expect(tinyTreatsAssetUrl("installed plugin/id", "baked-goods", "croissant")).toBe(
      "/_plugins/installed%20plugin%2Fid/ui/assets/tiny-treats/baked-goods/gltf/croissant.gltf",
    );
  });

  it("retains every GLTF dependency, catalog image, and CC0 license", () => {
    assertCompleteCollection("baked-goods", BAKED_GOODS_MODELS);
    assertCompleteCollection("charming-kitchen", CHARMING_KITCHEN_MODELS);
  });
});
