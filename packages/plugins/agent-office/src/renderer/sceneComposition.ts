import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { OfficeRoom } from "../projection.js";
import {
  CHARACTER_MODELS,
  type FurnitureModelName,
  type OfficeModelName,
} from "./assets.js";
import {
  ATRIUM_FURNITURE,
  OFFICE_ROOM_SIZE,
  ROOM_FURNITURE,
  ROOM_STATIONS,
  type FurniturePlacement,
} from "./sceneBlueprint.js";
import { officeCellPosition } from "./upstreamScene.js";
import { roomAmbiencePresentation } from "./roomAmbience.js";
import { channelHaloColor, statusLightProfile } from "./visualState.js";

export interface LoadedOfficeModel {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  size: THREE.Vector3;
}

export type OfficeModelMap = ReadonlyMap<OfficeModelName, LoadedOfficeModel>;

const ROOM_ACCENTS = [0xe8a36b, 0x6fa8c7, 0x8bbf8f, 0xc78fb0, 0xd9b15e];
const STATE_COLORS: Record<OfficeRoom["state"], number> = {
  idle: 0x9aa3b2,
  thinking: 0x7b6cf0,
  executing: 0x39ff6a,
  waiting: 0xef8a3a,
  error: 0xe0503a,
};

function roundedBox(
  width: number,
  height: number,
  depth: number,
  color: number,
  roughness = 0.74,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(width, height, depth, 2, 0.06),
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04 }),
  );
  mesh.userData.generated = true;
  return mesh;
}

function addMonitorGlow(screen: THREE.Object3D): void {
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.22),
    new THREE.MeshStandardMaterial({
      color: 0x7dd3fc,
      emissive: 0x38bdf8,
      emissiveIntensity: 1.35,
      roughness: 0.35,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  glow.name = "office-monitor-glow";
  glow.position.set(0, 0.15, 0.015);
  glow.userData.generated = true;
  screen.add(glow);
}

function addChannelHalo(agent: THREE.Object3D, room: OfficeRoom): void {
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 0.82, 32),
    new THREE.MeshBasicMaterial({
      color: channelHaloColor(room.channel),
      opacity: 0.76,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  halo.name = "office-channel-halo";
  halo.position.set(0, -0.05, 0);
  halo.rotation.x = -Math.PI / 2;
  halo.userData = { generated: true, channel: room.channel };
  agent.add(halo);
}

function addActivityBubbleAnchor(agent: THREE.Object3D, room: OfficeRoom): void {
  const anchor = new THREE.Group();
  anchor.name = "office-activity-bubble-anchor";
  anchor.position.set(0, 1.3, 0);
  anchor.userData = { generated: true, state: room.state, activity: "stationary" };
  agent.add(anchor);
}

function addRoomAmbience(group: THREE.Group, room: OfficeRoom, index: number): void {
  const profile = roomAmbiencePresentation(room.state);
  const ambience = new THREE.Group();
  ambience.name = "office-room-ambience";
  ambience.userData = { generated: true, state: room.state, profile, pulsePhase: index * 0.8 };
  const edgeLength = OFFICE_ROOM_SIZE - 0.24;
  const edgeOffset = OFFICE_ROOM_SIZE / 2 - 0.14;
  const placements = [
    { width: edgeLength, depth: 0.2, x: 0, z: -edgeOffset },
    { width: edgeLength, depth: 0.2, x: 0, z: edgeOffset },
    { width: 0.2, depth: edgeLength, x: -edgeOffset, z: 0 },
    { width: 0.2, depth: edgeLength, x: edgeOffset, z: 0 },
  ];
  placements.forEach(({ width, depth, x, z }) => {
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.05, depth),
      new THREE.MeshStandardMaterial({
        color: profile.color,
        emissive: profile.color,
        emissiveIntensity: 1.8,
        opacity: profile.minOpacity,
        transparent: true,
        depthWrite: false,
        roughness: 0.3,
        metalness: 0.05,
        toneMapped: false,
      }),
    );
    edge.name = "office-room-ambience-edge";
    edge.position.set(x, 0.195, z);
    edge.userData.generated = true;
    ambience.add(edge);
  });
  group.add(ambience);
}

function cloneModel(
  models: OfficeModelMap,
  name: OfficeModelName,
  scale = 1,
): THREE.Object3D | null {
  const source = models.get(name);
  if (!source) return null;
  const clone = cloneSkeleton(source.object);
  const deskWidth = models.get("desk")?.size.x ?? 1;
  const baseScale = name.startsWith("character-")
    ? 1.3 / Math.max(source.size.y, 0.001)
    : 1.3 / Math.max(deskWidth, 0.001);
  clone.scale.multiplyScalar(baseScale * scale);
  clone.userData.animations = source.animations;
  clone.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return clone;
}

function placeFurniture(
  parent: THREE.Object3D,
  models: OfficeModelMap,
  placement: FurniturePlacement,
): THREE.Object3D | null {
  const object = cloneModel(models, placement.model, placement.scale ?? 1);
  if (!object) return null;
  object.position.set(placement.x, 0.16, placement.z);
  object.rotation.y = placement.rotationY ?? 0;
  parent.add(object);
  return object;
}

function buildWorkstation(
  models: OfficeModelMap,
  station: (typeof ROOM_STATIONS)[number],
): THREE.Group {
  const group = new THREE.Group();
  group.name = "office-workstation";
  group.position.set(station.x, 0.16, station.z);

  const desk = cloneModel(models, "desk");
  if (desk) {
    desk.position.z = -1.1;
    group.add(desk);
  }
  const chair = cloneModel(models, "chairDesk");
  if (chair) {
    chair.rotation.y = Math.PI;
    group.add(chair);
  }
  for (let index = 0; index < station.screens; index += 1) {
    const screen = cloneModel(models, "computerScreen", 1.15);
    if (!screen) continue;
    screen.position.set((index - (station.screens - 1) / 2) * 0.66, 0.72, -1.15);
    addMonitorGlow(screen);
    group.add(screen);
  }
  return group;
}

function buildRoom(
  room: OfficeRoom,
  index: number,
  models: OfficeModelMap,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `office-room:${room.id}`;
  group.userData = { roomId: room.id, label: room.label, state: room.state };

  const floor = roundedBox(
    OFFICE_ROOM_SIZE,
    0.16,
    OFFICE_ROOM_SIZE,
    ROOM_ACCENTS[index % ROOM_ACCENTS.length],
  );
  floor.name = "office-room-floor";
  floor.position.y = 0.08;
  group.add(floor);
  addRoomAmbience(group, room, index);

  const wallHeight = 1.05;
  const northWall = roundedBox(OFFICE_ROOM_SIZE, wallHeight, 0.12, 0xfbf7ef, 0.7);
  northWall.name = "office-room-wall";
  northWall.position.set(0, wallHeight / 2 + 0.16, -OFFICE_ROOM_SIZE / 2 + 0.06);
  group.add(northWall);
  const westWall = roundedBox(0.12, wallHeight, OFFICE_ROOM_SIZE, 0xfbf7ef, 0.7);
  westWall.name = "office-room-wall";
  westWall.position.set(-OFFICE_ROOM_SIZE / 2 + 0.06, wallHeight / 2 + 0.16, 0);
  group.add(westWall);

  ROOM_STATIONS.forEach((station) => group.add(buildWorkstation(models, station)));
  ROOM_FURNITURE.forEach((placement) => placeFurniture(group, models, placement));

  const characterName = CHARACTER_MODELS[index % CHARACTER_MODELS.length];
  const agent = cloneModel(models, characterName, 0.9);
  if (agent) {
    agent.name = "office-agent";
    agent.userData.officeState = room.state;
    agent.position.set(0, 0.46, -2.5);
    agent.rotation.y = Math.PI;
    addChannelHalo(agent, room);
    addActivityBubbleAnchor(agent, room);
    group.add(agent);
  }

  const statusLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 12),
    new THREE.MeshBasicMaterial({
      color: STATE_COLORS[room.state],
      opacity: 0.9,
      transparent: true,
      toneMapped: false,
    }),
  );
  statusLight.name = "office-status-light";
  statusLight.userData = {
    generated: true,
    state: room.state,
    baseColor: STATE_COLORS[room.state],
    pulseProfile: statusLightProfile(room.state),
    pulsePhase: index * 0.7,
  };
  statusLight.position.set(0, 1.6, -2.5);
  group.add(statusLight);

  const position = officeCellPosition(index);
  group.position.set(position.x, 0, position.z);
  group.rotation.y = position.rotationY;
  return group;
}

function buildAtrium(models: OfficeModelMap): THREE.Group {
  const atrium = new THREE.Group();
  atrium.name = "agent-office-atrium";
  const floor = roundedBox(OFFICE_ROOM_SIZE, 0.16, OFFICE_ROOM_SIZE, 0xe8c98f);
  floor.position.y = 0.08;
  atrium.add(floor);
  ATRIUM_FURNITURE.forEach((placement) => placeFurniture(atrium, models, placement));
  return atrium;
}

export function buildOfficeEnvironment(
  rooms: OfficeRoom[],
  models: OfficeModelMap,
): THREE.Group {
  const environment = new THREE.Group();
  environment.name = "agent-office-environment";
  environment.add(buildAtrium(models));
  rooms.forEach((room, index) => environment.add(buildRoom(room, index, models)));
  return environment;
}
