import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OfficeRoom } from "../projection.js";
import type { OfficeModelMap } from "./sceneComposition.js";
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

  it("preserves ambient schedules when a refresh does not change scene state", () => {
    const scene = new THREE.Scene();
    const rooms: OfficeRoom[] = [
      { id: "idle", label: "Idle Agent", state: "idle", taskTitle: null, channel: "paperclip" },
    ];
    const controller = createOfficeEnvironmentController(scene, rooms, new Map(), () => undefined);
    const environment = scene.getObjectByName("agent-office-environment");

    controller.updateRooms(rooms.map((room) => ({ ...room, taskTitle: "Non-visual detail" })));

    expect(scene.getObjectByName("agent-office-environment")).toBe(environment);
    controller.dispose();
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

  it("wanders only idle actors and restores their idle presentation after movement", () => {
    const character = new THREE.Group();
    const clips = ["idle", "sit", "walk"].map((name) => new THREE.AnimationClip(name, 1));
    const models: OfficeModelMap = new Map([
      ["character-male-a", { object: character, animations: clips, size: new THREE.Vector3(1, 1, 1) }],
    ]);
    const values = [0, 1, 1, 0];
    const scene = new THREE.Scene();
    const idleRoom: OfficeRoom = {
      id: "idle",
      label: "Idle Agent",
      state: "idle",
      taskTitle: null,
      channel: "paperclip",
    };
    const controller = createOfficeEnvironmentController(
      scene,
      [idleRoom],
      models,
      () => undefined,
      () => values.shift() ?? 0,
    );
    const actor = scene.getObjectByName("office-agent")!;

    controller.updateAnimations(8);
    expect(actor.userData.officeMotion).toBe("walking");
    controller.updateAnimations(1);
    expect(actor.position.x).toBeGreaterThan(0);
    expect(actor.position.z).toBeGreaterThan(-2.5);
    controller.updateAnimations(10);
    expect(actor.userData.officeMotion).toBe("stationary");

    controller.updateRooms([{ ...idleRoom, state: "executing" }]);
    const executingActor = scene.getObjectByName("office-agent")!;
    const fixedPosition = executingActor.position.clone();
    controller.updateAnimations(30);
    expect(executingActor.position).toEqual(fixedPosition);
    expect(executingActor.userData.officeMotion).toBe("stationary");
    controller.dispose();
  });
});
