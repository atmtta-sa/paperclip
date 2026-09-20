import { describe, expect, it } from "vitest";
import type { OfficeState } from "../projection.js";
import { roomAmbiencePresentation } from "./roomAmbience.js";

const states: OfficeState[] = ["idle", "thinking", "executing", "waiting", "error"];

describe("room ambience presentation", () => {
  it("defines a distinct restrained treatment for every authoritative state", () => {
    const presentations = states.map(roomAmbiencePresentation);

    expect(new Set(presentations.map(({ color }) => color)).size).toBe(states.length);
    presentations.forEach(({ minOpacity, maxOpacity }) => {
      expect(minOpacity).toBeGreaterThanOrEqual(0.45);
      expect(maxOpacity).toBeLessThanOrEqual(0.85);
      expect(maxOpacity).toBeGreaterThanOrEqual(minOpacity);
    });
  });

  it("keeps idle static while active states communicate activity", () => {
    const idle = roomAmbiencePresentation("idle");
    const executing = roomAmbiencePresentation("executing");
    const waiting = roomAmbiencePresentation("waiting");
    const error = roomAmbiencePresentation("error");

    expect(idle.speed).toBe(0);
    expect(idle.minOpacity).toBeGreaterThanOrEqual(0.55);
    expect(idle.maxOpacity).toBe(idle.minOpacity);
    expect(executing.speed).toBeGreaterThan(waiting.speed);
    expect(error.speed).toBeGreaterThan(waiting.speed);
    expect(error.maxOpacity).toBeGreaterThan(executing.maxOpacity);
  });
});
