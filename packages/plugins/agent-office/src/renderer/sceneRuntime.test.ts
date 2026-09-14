import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OfficeRoom } from "../projection.js";
import { createOfficeEnvironmentController } from "./sceneRuntime.js";

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "sceneRuntime.ts");

describe("Agent Office Three.js runtime compatibility", () => {
  it("avoids removed or deprecated Three.js timing and shadow APIs", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("THREE.Clock");
    expect(source).not.toContain("PCFSoftShadowMap");
    expect(source).toContain("performance.now()");
    expect(source).toContain("THREE.PCFShadowMap");
  });

  it("updates room visuals without replacing or resetting the camera", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    camera.position.set(14, 22, 31);
    camera.zoom = 2.1;
    scene.add(camera);
    const initialRooms: OfficeRoom[] = [
      { id: "orp", label: "ORP Developer", state: "idle", taskTitle: null, channel: "paperclip" },
    ];

    const controller = createOfficeEnvironmentController(scene, initialRooms, new Map(), () => undefined);
    const initialEnvironment = scene.getObjectByName("agent-office-environment");
    controller.updateRooms([{ ...initialRooms[0]!, state: "executing", taskTitle: "Build API" }]);

    expect(scene.getObjectByName("agent-office-environment")).not.toBe(initialEnvironment);
    expect(initialEnvironment?.parent).toBeNull();
    expect(scene.children).toContain(camera);
    expect(camera.position.toArray()).toEqual([14, 22, 31]);
    expect(camera.zoom).toBe(2.1);
    controller.dispose();
  });
});
