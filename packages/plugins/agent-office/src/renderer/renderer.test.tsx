import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentOfficeRenderer } from "./AgentOfficeRenderer.js";
import { officeCellPosition } from "./upstreamScene.js";

const rooms = [
  { id: "orp", label: "ORP Developer", state: "executing" as const, taskTitle: "Build API", channel: "paperclip" },
  { id: "codex", label: "Codex Agent", state: "idle" as const, taskTitle: null, channel: "codex" },
];

describe("Agent Office renderer boundary", () => {
  it("preserves the upstream single-level inner-ring layout", () => {
    expect([0, 1, 2, 3, 4].map(officeCellPosition)).toEqual([
      { x: 0, z: 9.8, rotationY: -Math.PI },
      { x: 9.8, z: 0, rotationY: -Math.PI / 2 },
      { x: 0, z: -9.8, rotationY: -0 },
      { x: -9.8, z: 0, rotationY: Math.PI / 2 },
      { x: 9.8, z: 9.8, rotationY: -Math.PI },
    ]);
  });

  it("renders a labeled canvas owned by the React plugin", () => {
    const html = renderToStaticMarkup(<AgentOfficeRenderer rooms={rooms} />);

    expect(html).toContain('aria-label="Read-only 3D Agent Office"');
    expect(html).toContain('data-office-renderer="agent-office-upstream"');
    expect(html).toContain("Loading upstream office assets");
    expect(html).toContain("ORP Developer");
    expect(html).toContain("Codex Agent");
    expect(html).not.toContain("/cc/rooms");
    expect(html).not.toContain("button");
  });
});
