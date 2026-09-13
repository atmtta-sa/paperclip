import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CHARACTER_MODELS, FURNITURE_MODELS } from "./assets.js";
import { loadOfficeModels } from "./modelLoader.js";

function loadedScene() {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial());
  mesh.position.set(3, 1.5, -2);
  scene.add(mesh);
  return { scene, animations: [new THREE.AnimationClip("sit", 1)] };
}

describe("Agent Office model loader", () => {
  it("loads and normalizes the bounded upstream inventory", async () => {
    const loadOne = vi.fn(async () => loadedScene());

    const models = await loadOfficeModels("installed-plugin-id", loadOne);

    expect(loadOne).toHaveBeenCalledTimes(FURNITURE_MODELS.length + CHARACTER_MODELS.length);
    expect(loadOne).toHaveBeenNthCalledWith(
      1,
      "/_plugins/installed-plugin-id/ui/assets/kenney/desk.glb",
    );
    expect(models.get("desk")?.size.toArray()).toEqual([2, 3, 4]);
    expect(models.get("desk")?.animations[0]?.name).toBe("sit");
  });

  it("resolves the installed plugin UUID from Paperclip contributions", async () => {
    const readJson = vi.fn(async () => [
      { pluginId: "installed-plugin-id", pluginKey: "paperclip.agent-office" },
    ]);

    const { resolveInstalledPluginId } = await import("./modelLoader.js");

    await expect(resolveInstalledPluginId(readJson)).resolves.toBe("installed-plugin-id");
    expect(readJson).toHaveBeenCalledWith("/api/plugins/ui-contributions");
  });
});
