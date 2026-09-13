import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { OfficeRoom } from "../projection.js";
import { CHARACTER_MODELS, FURNITURE_MODELS, type OfficeModelName } from "./assets.js";
import { buildOfficeEnvironment, type LoadedOfficeModel } from "./sceneComposition.js";

const rooms: OfficeRoom[] = [
  "ORP Developer",
  "Whattsi Developer",
  "Team Lead",
  "Codex Agent",
  "Hermes Agent",
].map((label, index) => ({
  id: String(index),
  label,
  state: index === 0 ? "executing" : "idle",
  taskTitle: null,
  channel: "paperclip",
}));

function model(name: OfficeModelName): LoadedOfficeModel {
  const object = new THREE.Group();
  object.name = `model:${name}`;
  object.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  return { object, animations: [], size: new THREE.Vector3(1, 1, 1) };
}

describe("Agent Office scene composition", () => {
  it("builds the upstream furnished five-room campus and central atrium", () => {
    const models = new Map<OfficeModelName, LoadedOfficeModel>();
    [...FURNITURE_MODELS, ...CHARACTER_MODELS].forEach((name) => models.set(name, model(name)));

    const environment = buildOfficeEnvironment(rooms, models);

    expect(environment.getObjectByName("agent-office-atrium")).toBeDefined();
    expect(environment.children.filter((child) => child.name.startsWith("office-room:"))).toHaveLength(5);
    expect(environment.getObjectsByProperty("name", "office-workstation")).toHaveLength(25);
    expect(environment.getObjectsByProperty("name", "office-agent")).toHaveLength(5);
    expect(environment.getObjectsByProperty("name", "office-status-light")).toHaveLength(5);
  });
});
