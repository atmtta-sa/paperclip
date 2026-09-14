import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OfficeState } from "../projection.js";
import {
  channelHaloColor,
  resolveAnimationClip,
  statusLightProfile,
} from "./visualState.js";

const states: OfficeState[] = ["idle", "thinking", "executing", "waiting", "error"];

describe("Agent Office visual state", () => {
  it.each([
    ["paperclip", 0x38bdf8],
    ["codex", 0xa78bfa],
    ["hermes", 0xf97316],
    ["unknown-provider", 0xec4899],
  ])("uses a stable halo color for %s", (channel, expected) => {
    expect(channelHaloColor(channel)).toBe(expected);
  });

  it.each([
    ["idle", "sit"],
    ["thinking", "idle"],
    ["executing", "interact-right"],
    ["waiting", "sit"],
    ["error", "crouch"],
  ] satisfies [OfficeState, string][])("resolves %s to the preferred available clip", (state, expected) => {
    const clips = ["STATIC", "Idle", "Sit", "Interact-Right", "Crouch"].map(
      (name) => new THREE.AnimationClip(name),
    );

    expect(resolveAnimationClip(state, clips)?.name.toLowerCase()).toBe(expected);
  });

  it("falls back case-insensitively to idle, sit, then the first available clip", () => {
    expect(resolveAnimationClip("executing", [new THREE.AnimationClip("IDLE")])?.name).toBe("IDLE");
    expect(resolveAnimationClip("error", [new THREE.AnimationClip("SIT")])?.name).toBe("SIT");
    expect(resolveAnimationClip("thinking", [new THREE.AnimationClip("wave")])?.name).toBe("wave");
    expect(resolveAnimationClip("idle", [])).toBeUndefined();
  });

  it("defines a restrained status-light animation profile for every projected state", () => {
    const profiles = states.map(statusLightProfile);

    expect(profiles).toHaveLength(states.length);
    profiles.forEach((profile) => {
      expect(profile.speed).toBeGreaterThanOrEqual(0);
      expect(profile.speed).toBeLessThanOrEqual(2);
      expect(profile.minIntensity).toBeGreaterThanOrEqual(0.5);
      expect(profile.maxIntensity).toBeLessThanOrEqual(1.5);
      expect(profile.maxIntensity).toBeGreaterThanOrEqual(profile.minIntensity);
    });
    expect(new Set(profiles.map((profile) => JSON.stringify(profile))).size).toBe(states.length);
  });
});
