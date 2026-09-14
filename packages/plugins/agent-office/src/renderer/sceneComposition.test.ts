import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
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
  channel: index === 3 ? "codex" : index === 4 ? "hermes" : "paperclip",
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
    const bubbleAnchors = environment.getObjectsByProperty("name", "office-activity-bubble-anchor");
    expect(bubbleAnchors).toHaveLength(5);
    bubbleAnchors.forEach((anchor) => expect(anchor.position.y).toBeLessThanOrEqual(1.3));
    expect(environment.getObjectsByProperty("name", "office-status-light")).toHaveLength(5);
  });

  it("uses polished rounded room surfaces", () => {
    const models = new Map<OfficeModelName, LoadedOfficeModel>();
    [...FURNITURE_MODELS, ...CHARACTER_MODELS].forEach((name) => models.set(name, model(name)));

    const environment = buildOfficeEnvironment(rooms, models);
    const floors = environment.getObjectsByProperty("name", "office-room-floor") as THREE.Mesh[];
    const walls = environment.getObjectsByProperty("name", "office-room-wall") as THREE.Mesh[];

    expect(floors).toHaveLength(5);
    expect(walls).toHaveLength(10);
    [...floors, ...walls].forEach((surface) => {
      expect(surface.geometry).toBeInstanceOf(RoundedBoxGeometry);
      expect(surface.material).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect((surface.material as THREE.MeshStandardMaterial).roughness).toBeLessThan(0.86);
      expect(surface.userData.generated).toBe(true);
    });
  });

  it("adds one four-sided state-reactive ambience edge to every room", () => {
    const models = new Map<OfficeModelName, LoadedOfficeModel>();
    [...FURNITURE_MODELS, ...CHARACTER_MODELS].forEach((name) => models.set(name, model(name)));

    const environment = buildOfficeEnvironment(rooms, models);
    const ambienceGroups = environment.getObjectsByProperty("name", "office-room-ambience");
    const ambienceEdges = environment.getObjectsByProperty("name", "office-room-ambience-edge") as THREE.Mesh[];

    expect(ambienceGroups).toHaveLength(rooms.length);
    expect(ambienceEdges).toHaveLength(rooms.length * 4);
    ambienceGroups.forEach((ambience, index) => {
      expect(ambience.userData.state).toBe(rooms[index]?.state);
      expect(ambience.userData.profile).toEqual(expect.objectContaining({
        speed: expect.any(Number),
        minOpacity: expect.any(Number),
        maxOpacity: expect.any(Number),
      }));
    });
    ambienceEdges.forEach((edge) => {
      expect(edge.material).toBeInstanceOf(THREE.MeshStandardMaterial);
      const material = edge.material as THREE.MeshStandardMaterial;
      expect(material.emissiveIntensity).toBeGreaterThanOrEqual(1.5);
      expect(material.emissive.getHex()).toBe(material.color.getHex());
      expect(edge.geometry).toBeInstanceOf(THREE.BoxGeometry);
      const geometry = edge.geometry as THREE.BoxGeometry;
      expect(geometry.parameters.height).toBeGreaterThanOrEqual(0.04);
      expect(edge.position.y).toBeGreaterThan(0.16);
    });
  });

  it("adds one emissive glow surface for every workstation monitor", () => {
    const models = new Map<OfficeModelName, LoadedOfficeModel>();
    [...FURNITURE_MODELS, ...CHARACTER_MODELS].forEach((name) => models.set(name, model(name)));

    const environment = buildOfficeEnvironment(rooms, models);
    const glows = environment.getObjectsByProperty("name", "office-monitor-glow") as THREE.Mesh[];

    expect(glows).toHaveLength(35);
    glows.forEach((glow) => {
      expect(glow.material).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect((glow.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
      expect(glow.geometry).toBeInstanceOf(THREE.PlaneGeometry);
      expect((glow.geometry as THREE.PlaneGeometry).parameters.width).toBeLessThanOrEqual(0.4);
      expect((glow.geometry as THREE.PlaneGeometry).parameters.height).toBeLessThanOrEqual(0.3);
      expect(glow.position.y).toBeGreaterThan(0);
      expect(glow.position.y).toBeLessThan(0.3);
      expect(Math.abs(glow.position.z)).toBeLessThanOrEqual(0.03);
      expect(glow.userData.generated).toBe(true);
    });
  });

  it("adds exactly one stable channel halo and animation state to every character", () => {
    const models = new Map<OfficeModelName, LoadedOfficeModel>();
    [...FURNITURE_MODELS, ...CHARACTER_MODELS].forEach((name) => models.set(name, model(name)));

    const environment = buildOfficeEnvironment(rooms, models);
    const agents = environment.getObjectsByProperty("name", "office-agent");
    const halos = environment.getObjectsByProperty("name", "office-channel-halo") as THREE.Mesh[];

    expect(halos).toHaveLength(agents.length);
    expect(halos.map((halo) => halo.userData.channel)).toEqual(rooms.map((room) => room.channel));
    halos.forEach((halo) => {
      expect(halo.position.y).toBeGreaterThanOrEqual(-0.1);
      expect((halo.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThanOrEqual(0.7);
    });
    agents.forEach((agent, index) => expect(agent.userData.officeState).toBe(rooms[index]?.state));
  });

  it("attaches a pulse profile and authoritative base color to every status light", () => {
    const models = new Map<OfficeModelName, LoadedOfficeModel>();
    [...FURNITURE_MODELS, ...CHARACTER_MODELS].forEach((name) => models.set(name, model(name)));

    const environment = buildOfficeEnvironment(rooms, models);
    const lights = environment.getObjectsByProperty("name", "office-status-light") as THREE.Mesh[];

    expect(lights).toHaveLength(rooms.length);
    lights.forEach((light, index) => {
      expect(light.userData.state).toBe(rooms[index]?.state);
      expect(light.userData.pulseProfile).toEqual(expect.objectContaining({
        speed: expect.any(Number),
        minIntensity: expect.any(Number),
        maxIntensity: expect.any(Number),
      }));
      expect(light.userData.baseColor).toBe((light.material as THREE.MeshBasicMaterial).color.getHex());
    });
  });
});
