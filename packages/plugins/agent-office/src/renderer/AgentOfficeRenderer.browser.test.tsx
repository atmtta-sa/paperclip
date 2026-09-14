// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./modelLoader.js", () => ({
  resolveInstalledPluginId: vi.fn(async () => "installed-agent-office"),
  loadOfficeModels: vi.fn(async () => new Map()),
}));

vi.mock("./sceneRuntime.js", () => ({
  createOfficeScene: vi.fn(() => ({ updateRooms: vi.fn(), dispose: vi.fn() })),
}));

import { AgentOfficeRenderer } from "./AgentOfficeRenderer.js";

const rooms = [
  { id: "orp", label: "ORP Developer", state: "idle" as const, taskTitle: null, channel: "paperclip" },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe("Agent Office expanded view", () => {
  it("fills the viewport until Escape exits", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<AgentOfficeRenderer rooms={rooms} />));

    const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand Agent Office"]');
    expect(expand).not.toBeNull();
    flushSync(() => expand!.click());
    const renderer = container.querySelector<HTMLElement>('[data-office-renderer="agent-office-upstream"]');
    expect(renderer?.dataset.officeExpanded).toBe("true");
    expect(container.querySelector('[aria-label="Exit expanded Agent Office"]')).not.toBeNull();

    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(renderer?.dataset.officeExpanded).toBe("false");
    root.unmount();
  });
});