import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OfficeRoom } from "../projection.js";
import type { OfficeModelMap } from "./sceneComposition.js";
import {
  createOfficeEnvironmentController,
  ROOM_LABEL_BACKGROUND,
  ROOM_LABEL_PLACEMENT,
} from "./sceneRuntime.js";

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "sceneRuntime.ts");

describe("Agent Office Three.js runtime compatibility", () => {
  it("keeps room labels lightly translucent behind their text", () => {
    expect(ROOM_LABEL_BACKGROUND).toBe("rgba(15, 23, 42, 0.55)");
  });

  it("mounts room labels vertically above the north wall", () => {
    expect(ROOM_LABEL_PLACEMENT).toEqual({ x: 1.35, y: 1.62, z: -4.28, rotationX: 0 });
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("new THREE.PlaneGeometry(5.2, 0.92)");
    expect(source).not.toContain("new THREE.Sprite(material)");
  });

  it("avoids removed or deprecated Three.js timing and shadow APIs", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("THREE.Clock");
    expect(source).not.toContain("PCFSoftShadowMap");
    expect(source).toContain("performance.now()");
    expect(source).toContain("THREE.PCFShadowMap");
  });

  it("pulses active room ambience while keeping idle ambience static", () => {
    const scene = new THREE.Scene();
    const rooms: OfficeRoom[] = [
      { id: "active", label: "Active Agent", state: "executing", taskTitle: "Build", channel: "paperclip" },
      { id: "idle", label: "Idle Agent", state: "idle", taskTitle: null, channel: "paperclip" },
    ];
    const controller = createOfficeEnvironmentController(scene, rooms, new Map(), () => undefined);
    const ambience = scene.getObjectsByProperty("name", "office-room-ambience");
    const opacity = (object: THREE.Object3D) => {
      const edge = object.getObjectByName("office-room-ambience-edge") as THREE.Mesh;
      return (edge.material as THREE.MeshBasicMaterial).opacity;
    };
    const activeBefore = opacity(ambience[0]!);
    const idleBefore = opacity(ambience[1]!);

    controller.updateAnimations(0.25);

    expect(opacity(ambience[0]!)).not.toBe(activeBefore);
    expect(opacity(ambience[1]!)).toBe(idleBefore);
    controller.dispose();
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

  it("takes an idle actor to its lounge slot and returns it home", () => {
    const character = new THREE.Group();
    const clips = ["idle", "walk"].map((name) => new THREE.AnimationClip(name, 1));
    const models: OfficeModelMap = new Map([
      ["character-male-a", { object: character, animations: clips, size: new THREE.Vector3(1, 1, 1) }],
    ]);
    const scene = new THREE.Scene();
    const controller = createOfficeEnvironmentController(
      scene,
      [{ id: "idle", label: "Idle Agent", state: "idle", taskTitle: null, channel: "paperclip" }],
      models,
      () => undefined,
      () => 0,
    );
    const actor = scene.getObjectByName("office-agent")!;
    const home = new THREE.Vector3();
    actor.getWorldPosition(home);

    controller.updateAnimations(45);
    expect(actor.userData.officeMotion).toBe("walking");
    expect(actor.getObjectByName("office-activity-bubble-anchor")?.userData.activity).toBe("coffee-break");
    controller.updateAnimations(60);
    const lounge = new THREE.Vector3();
    actor.getWorldPosition(lounge);
    expect(lounge.x).toBeCloseTo(-1.6);
    expect(lounge.z).toBeCloseTo(-1.35);
    expect(actor.getObjectByName("office-channel-halo")).not.toBeNull();

    controller.updateAnimations(6);
    controller.updateAnimations(60);
    const returned = new THREE.Vector3();
    actor.getWorldPosition(returned);
    expect(returned.x).toBeCloseTo(home.x);
    expect(returned.z).toBeCloseTo(home.z);
    expect(actor.userData.officeMotion).toBe("stationary");
    expect(actor.getObjectByName("office-activity-bubble-anchor")?.userData.activity).toBe("stationary");
    controller.dispose();
  });

  it("wanders only idle actors and restores their idle presentation after movement", () => {
    const character = new THREE.Group();
    const clips = ["idle", "sit", "walk"].map((name) => new THREE.AnimationClip(name, 1));
    const models: OfficeModelMap = new Map([
      ["character-male-a", { object: character, animations: clips, size: new THREE.Vector3(1, 1, 1) }],
    ]);
    const values = [0, 1, 1, 1, 0];
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
