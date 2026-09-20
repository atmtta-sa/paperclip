import { describe, expect, it } from "vitest";
import type { OfficeState } from "../projection.js";
import { ACTIVITY_BUBBLE_COLORS, activityBubblePresentation } from "./activityBubble.js";

const states: OfficeState[] = ["idle", "thinking", "executing", "waiting", "error"];

describe("Agent Office activity bubble presentation", () => {
  it("uses a blue plate that stays visually distinct from dark room labels", () => {
    expect(ACTIVITY_BUBBLE_COLORS).toEqual({
      plate: "rgba(29, 78, 216, 0.94)",
      border: "rgba(219, 234, 254, 0.98)",
      text: "#ffffff",
    });
  });

  it("maps authoritative states to compact readable symbols", () => {
    expect(states.map((state) => activityBubblePresentation(state, "stationary"))).toEqual([
      { symbol: "Zz", label: "Idle" },
      { symbol: "…", label: "Thinking" },
      { symbol: "</>", label: "Coding" },
      { symbol: "⌛", label: "Waiting" },
      { symbol: "!", label: "Error" },
    ]);
  });

  it("lets current coffee-break presentation override idle", () => {
    expect(activityBubblePresentation("idle", "coffee-break")).toEqual({
      symbol: "☕",
      label: "Coffee break",
    });
  });

  it("does not let visual movement override non-idle authority", () => {
    expect(activityBubblePresentation("executing", "coffee-break")).toEqual({
      symbol: "</>",
      label: "Coding",
    });
  });
});
