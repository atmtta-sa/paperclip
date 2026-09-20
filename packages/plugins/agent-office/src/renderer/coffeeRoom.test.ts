import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  COFFEE_ROOM_MODEL_SPECS,
  COFFEE_ROOM_POSITION,
  createCoffeeRoom,
} from "./coffeeRoom.js";
import type { LoadedOfficeModel } from "./sceneComposition.js";

function model(name: string): LoadedOfficeModel {
  const object = new THREE.Group();
  object.name = `model:${name}`;
  object.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  return { object, animations: [], size: new THREE.Vector3(1, 1, 1) };
}

describe("Tiny Treats coffee room", () => {
  it("occupies the rear-right perimeter while keeping the central atrium clear", () => {
    expect(COFFEE_ROOM_POSITION).toEqual({ x: 9.8, z: -9.8 });
    expect(Math.hypot(COFFEE_ROOM_POSITION.x, COFFEE_ROOM_POSITION.z)).toBeGreaterThan(12);

    const models = new Map(COFFEE_ROOM_MODEL_SPECS.map(({ model: name }) => [name, model(name)]));
    const room = createCoffeeRoom(models);

    expect(room.name).toBe("agent-office-coffee-room");
    expect(room.position.toArray()).toEqual([9.8, 0, -9.8]);
    expect(room.getObjectByName("agent-office-coffee-room-floor")).toBeDefined();
    const walls = room.getObjectsByProperty("name", "agent-office-coffee-room-wall");
    expect(walls).toHaveLength(1);
    expect(walls[0]?.position.toArray()).toEqual([0, 1.8, -4.3]);
  });

  it("uses a restrained curated composition from both Tiny Treats collections", () => {
    const uniqueModels = new Set(COFFEE_ROOM_MODEL_SPECS.map(({ model }) => model));
    const models = new Map([...uniqueModels].map((name) => [name, model(name)]));

    const room = createCoffeeRoom(models);
    const props = room.getObjectsByProperty("name", "agent-office-coffee-room-prop");

    expect(uniqueModels.size).toBeLessThanOrEqual(18);
    expect(COFFEE_ROOM_MODEL_SPECS.some(({ collection }) => collection === "charming-kitchen")).toBe(true);
    expect(COFFEE_ROOM_MODEL_SPECS.some(({ collection }) => collection === "baked-goods")).toBe(true);
    expect(props).toHaveLength(COFFEE_ROOM_MODEL_SPECS.length);
  });
});
