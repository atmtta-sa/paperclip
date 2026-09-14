import * as THREE from "three";
import type { OfficeState } from "../projection.js";

export interface RoomAmbiencePresentation {
  color: number;
  speed: number;
  minOpacity: number;
  maxOpacity: number;
}

const PRESENTATIONS: Readonly<Record<OfficeState, RoomAmbiencePresentation>> = {
  idle: { color: 0x2563eb, speed: 0, minOpacity: 0.58, maxOpacity: 0.58 },
  thinking: { color: 0x8b5cf6, speed: 0.45, minOpacity: 0.48, maxOpacity: 0.68 },
  executing: { color: 0x22c55e, speed: 0.9, minOpacity: 0.5, maxOpacity: 0.76 },
  waiting: { color: 0xf59e0b, speed: 0.3, minOpacity: 0.5, maxOpacity: 0.72 },
  error: { color: 0xef4444, speed: 0.75, minOpacity: 0.56, maxOpacity: 0.84 },
};

export function roomAmbiencePresentation(state: OfficeState): RoomAmbiencePresentation {
  return PRESENTATIONS[state];
}

export function updateRoomAmbience(environment: THREE.Group, elapsed: number): void {
  environment.getObjectsByProperty("name", "office-room-ambience").forEach((ambience) => {
    const profile = ambience.userData.profile as RoomAmbiencePresentation | undefined;
    if (!profile) return;
    const phase = Number(ambience.userData.pulsePhase) || 0;
    const progress = profile.speed === 0
      ? 0
      : (Math.sin(elapsed * profile.speed * Math.PI * 2 + phase) + 1) / 2;
    const opacity = profile.minOpacity + (profile.maxOpacity - profile.minOpacity) * progress;
    ambience.children.forEach((edge) => {
      if (edge instanceof THREE.Mesh && edge.material instanceof THREE.MeshStandardMaterial) {
        edge.material.opacity = opacity;
      }
    });
  });
}
