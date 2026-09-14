import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { OfficeState } from "../projection.js";
import {
  ambientMotionProfile,
  createAmbientActorMotion,
  projectAmbientDelay,
  projectAmbientWaypoint,
} from "./ambientMotion.js";

const states: OfficeState[] = ["idle", "thinking", "executing", "waiting", "error"];

describe("Agent Office ambient actor motion", () => {
  it("allows only idle actors to wander", () => {
    expect(states.map((state) => ambientMotionProfile(state) !== null)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("projects random values into a bounded furniture-safe room lane", () => {
    const profile = ambientMotionProfile("idle");
    expect(profile).not.toBeNull();

    expect(projectAmbientWaypoint(profile!, 0, 0)).toEqual({ x: -0.72, z: -2.5 });
    expect(projectAmbientWaypoint(profile!, 0.5, 0.5)).toEqual({ x: 0, z: -2.15 });
    expect(projectAmbientWaypoint(profile!, 1, 1)).toEqual({ x: 0.72, z: -1.8 });
  });

  it("clamps random waypoint inputs so actors cannot leave their lane", () => {
    const profile = ambientMotionProfile("idle");
    expect(projectAmbientWaypoint(profile!, -1, 2)).toEqual({ x: -0.72, z: -1.8 });
  });

  it("projects pauses into the approved 8 to 18 second interval", () => {
    expect(projectAmbientDelay(0)).toBe(8);
    expect(projectAmbientDelay(0.5)).toBe(13);
    expect(projectAmbientDelay(1)).toBe(18);
    expect(projectAmbientDelay(2)).toBe(18);
  });

  it("moves an idle actor only after its pause and switches walking presentation", () => {
    const actor = new THREE.Group();
    actor.position.set(0, 0.46, -2.5);
    const setWalking = vi.fn();
    const values = [0, 1, 1, 0];
    const motion = createAmbientActorMotion(actor, "idle", () => values.shift() ?? 0, setWalking);

    expect(motion).not.toBeNull();
    motion!.update(7.9);
    expect(actor.position.toArray()).toEqual([0, 0.46, -2.5]);
    expect(setWalking).not.toHaveBeenCalled();

    motion!.update(0.1);
    expect(setWalking).toHaveBeenLastCalledWith(true);
    motion!.update(10);
    expect(actor.position.x).toBeCloseTo(0.72);
    expect(actor.position.z).toBeCloseTo(-1.8);
    expect(setWalking).toHaveBeenLastCalledWith(false);
  });

  it("resets an interrupted wander without moving the actor", () => {
    const actor = new THREE.Group();
    actor.position.set(0, 0.46, -2.5);
    const setWalking = vi.fn();
    const motion = createAmbientActorMotion(actor, "idle", () => 0, setWalking)!;

    motion.update(8);
    expect(setWalking).toHaveBeenLastCalledWith(true);
    motion.reset();
    expect(setWalking).toHaveBeenLastCalledWith(false);
    const resetPosition = actor.position.clone();
    motion.update(7.9);
    expect(actor.position).toEqual(resetPosition);
  });

  it("does not create ambient motion for non-idle actors", () => {
    const actor = new THREE.Group();
    expect(createAmbientActorMotion(actor, "executing", () => 0, vi.fn())).toBeNull();
  });
});
