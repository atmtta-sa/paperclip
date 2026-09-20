import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { OfficeState } from "../projection.js";
import {
  coffeeBreakProfile,
  createCoffeeBreakMotion,
  projectCoffeeBreakDelay,
  projectCoffeeBreakPause,
  projectCoffeeSpot,
} from "./coffeeBreak.js";

const states: OfficeState[] = ["idle", "thinking", "executing", "waiting", "error"];

describe("Agent Office coffee-break motion", () => {
  it("allows coffee breaks only for idle actors at a practical cross-office speed", () => {
    expect(states.map((state) => coffeeBreakProfile(state) !== null)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(coffeeBreakProfile("idle")?.speed).toBe(1.1);
  });

  it("assigns stable lounge slots around rather than on the central furniture", () => {
    const spots = [0, 1, 2, 3, 4].map(projectCoffeeSpot);
    expect(spots).toEqual([
      { x: -1.6, z: -1.35 },
      { x: 1.6, z: -1.35 },
      { x: -1.7, z: 1.25 },
      { x: 1.7, z: 1.25 },
      { x: 1.85, z: 0 },
    ]);
    expect(projectCoffeeSpot(5)).toEqual(spots[0]);
    for (const left of spots) {
      for (const right of spots) {
        if (left === right) continue;
        expect(Math.hypot(left.x - right.x, left.z - right.z)).toBeGreaterThan(1.2);
      }
      expect(Math.hypot(left.x - 0.1, left.z - 0.2)).toBeGreaterThan(1.6);
    }
  });

  it("bounds the interval and lounge pause", () => {
    expect(projectCoffeeBreakDelay(0)).toBe(45);
    expect(projectCoffeeBreakDelay(1)).toBe(75);
    expect(projectCoffeeBreakPause(0)).toBe(6);
    expect(projectCoffeeBreakPause(1)).toBe(10);
  });

  it("walks an outbound route, pauses, and returns home", () => {
    const actor = new THREE.Group();
    actor.position.set(0, 0.46, -2.5);
    const home = actor.position.clone();
    const route = [
      new THREE.Vector3(3, 0.46, -2.5),
      new THREE.Vector3(3, 0.46, 4.8),
      new THREE.Vector3(4, 0.46, 5.2),
    ];
    const setWalking = vi.fn();
    const motion = createCoffeeBreakMotion(actor, "idle", route, () => 0, setWalking);

    expect(motion).not.toBeNull();
    motion!.update(44.9);
    expect(actor.position).toEqual(home);

    motion!.update(0.1);
    expect(setWalking).toHaveBeenLastCalledWith(true);
    motion!.update(60);
    expect(actor.position).toEqual(route.at(-1));
    expect(setWalking).toHaveBeenLastCalledWith(false);

    motion!.update(5.9);
    expect(actor.position).toEqual(route.at(-1));
    motion!.update(0.1);
    expect(setWalking).toHaveBeenLastCalledWith(true);
    motion!.update(60);
    expect(actor.position).toEqual(home);
    expect(setWalking).toHaveBeenLastCalledWith(false);
  });

  it("does not create a coffee route for non-idle actors", () => {
    expect(createCoffeeBreakMotion(new THREE.Group(), "executing", [], () => 0, vi.fn())).toBeNull();
  });
});
