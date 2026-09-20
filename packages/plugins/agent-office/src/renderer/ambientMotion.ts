import * as THREE from "three";
import type { OfficeState } from "../projection.js";

export interface AmbientMotionProfile {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  speed: number;
}

const IDLE_MOTION: AmbientMotionProfile = {
  minX: -0.72,
  maxX: 0.72,
  minZ: -2.5,
  maxZ: -1.8,
  speed: 0.32,
};

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function ambientMotionProfile(state: OfficeState): AmbientMotionProfile | null {
  return state === "idle" ? IDLE_MOTION : null;
}

export function projectAmbientWaypoint(
  profile: AmbientMotionProfile,
  randomX: number,
  randomZ: number,
): { x: number; z: number } {
  return {
    x: profile.minX + (profile.maxX - profile.minX) * clampUnit(randomX),
    z: profile.minZ + (profile.maxZ - profile.minZ) * clampUnit(randomZ),
  };
}

export function projectAmbientDelay(random: number): number {
  return 8 + 10 * clampUnit(random);
}

export interface AmbientActorMotion {
  update: (delta: number) => void;
  reset: () => void;
}

export function createAmbientActorMotion(
  actor: THREE.Object3D,
  state: OfficeState,
  random: () => number = Math.random,
  setWalking: (walking: boolean) => void = () => undefined,
): AmbientActorMotion | null {
  const profile = ambientMotionProfile(state);
  if (!profile) return null;

  let elapsed = 0;
  let moveStartedAt = 0;
  let nextMoveAt = projectAmbientDelay(random());
  let duration = 0;
  let moving = false;
  const from = new THREE.Vector3();
  const target = new THREE.Vector3();

  return {
    reset: () => {
      moving = false;
      setWalking(false);
      nextMoveAt = elapsed + projectAmbientDelay(random());
    },
    update: (delta) => {
      elapsed += delta;
      if (!moving && elapsed >= nextMoveAt) {
        from.copy(actor.position);
        const waypoint = projectAmbientWaypoint(profile, random(), random());
        target.set(waypoint.x, actor.position.y, waypoint.z);
        const distance = from.distanceTo(target);
        duration = distance / profile.speed;
        moveStartedAt = elapsed;
        moving = distance > 0.001;
        if (moving) {
          actor.rotation.y = Math.atan2(target.x - from.x, target.z - from.z);
          setWalking(true);
        } else {
          nextMoveAt = elapsed + projectAmbientDelay(random());
        }
      }

      if (!moving) return;
      const progress = Math.min((elapsed - moveStartedAt) / duration, 1);
      const eased = progress * progress * (3 - 2 * progress);
      actor.position.lerpVectors(from, target, eased);
      if (progress < 1) return;

      moving = false;
      setWalking(false);
      nextMoveAt = elapsed + projectAmbientDelay(random());
    },
  };
}
