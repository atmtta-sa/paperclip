import * as THREE from "three";
import type { OfficeState } from "../projection.js";

export interface CoffeeBreakProfile {
  speed: number;
}

const IDLE_COFFEE_BREAK: CoffeeBreakProfile = { speed: 1.1 };
const COFFEE_SPOTS = [
  { x: -1.6, z: -1.35 },
  { x: 1.6, z: -1.35 },
  { x: -1.7, z: 1.25 },
  { x: 1.7, z: 1.25 },
  { x: 1.85, z: 0 },
] as const;

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function coffeeBreakProfile(state: OfficeState): CoffeeBreakProfile | null {
  return state === "idle" ? IDLE_COFFEE_BREAK : null;
}

export function projectCoffeeSpot(index: number): { x: number; z: number } {
  const slot = ((Math.trunc(index) % COFFEE_SPOTS.length) + COFFEE_SPOTS.length) % COFFEE_SPOTS.length;
  const spot = COFFEE_SPOTS[slot];
  return { x: spot.x, z: spot.z };
}

export function projectCoffeeBreakDelay(random: number): number {
  return 45 + 30 * clampUnit(random);
}

export function projectCoffeeBreakPause(random: number): number {
  return 6 + 4 * clampUnit(random);
}

export interface CoffeeBreakMotion {
  update: (delta: number) => void;
  isActive: () => boolean;
}

type TravelDirection = "outbound" | "returning";

export function createCoffeeBreakMotion(
  actor: THREE.Object3D,
  state: OfficeState,
  outboundRoute: readonly THREE.Vector3[],
  random: () => number = Math.random,
  setWalking: (walking: boolean) => void = () => undefined,
): CoffeeBreakMotion | null {
  const profile = coffeeBreakProfile(state);
  if (!profile || outboundRoute.length === 0) return null;

  const home = actor.position.clone();
  let elapsed = 0;
  let nextBreakAt = projectCoffeeBreakDelay(random());
  let loungeUntil = Number.POSITIVE_INFINITY;
  let direction: TravelDirection | null = null;
  let route: THREE.Vector3[] = [];
  let routeIndex = 0;
  let segmentElapsed = 0;
  const segmentStart = new THREE.Vector3();

  const startRoute = (nextDirection: TravelDirection) => {
    direction = nextDirection;
    if (nextDirection === "outbound") nextBreakAt = Number.POSITIVE_INFINITY;
    route = nextDirection === "outbound"
      ? outboundRoute.map((point) => point.clone())
      : [...outboundRoute.slice(0, -1)].reverse().map((point) => point.clone()).concat(home.clone());
    routeIndex = 0;
    segmentElapsed = 0;
    segmentStart.copy(actor.position);
    const target = route[0];
    actor.rotation.y = Math.atan2(target.x - actor.position.x, target.z - actor.position.z);
    setWalking(true);
  };

  const finishRoute = () => {
    setWalking(false);
    if (direction === "outbound") {
      direction = null;
      loungeUntil = elapsed + projectCoffeeBreakPause(random());
      return;
    }
    direction = null;
    nextBreakAt = elapsed + projectCoffeeBreakDelay(random());
  };

  const advanceRoute = (delta: number) => {
    let remaining = delta;
    while (direction && remaining >= 0) {
      const target = route[routeIndex];
      const duration = segmentStart.distanceTo(target) / profile.speed;
      const available = Math.max(duration - segmentElapsed, 0);
      const consumed = Math.min(remaining, available);
      segmentElapsed += consumed;
      remaining -= consumed;
      const progress = duration === 0 ? 1 : Math.min(segmentElapsed / duration, 1);
      const eased = progress * progress * (3 - 2 * progress);
      actor.position.lerpVectors(segmentStart, target, eased);
      if (progress < 1) return;

      routeIndex += 1;
      if (routeIndex >= route.length) {
        finishRoute();
        return;
      }
      segmentStart.copy(actor.position);
      segmentElapsed = 0;
      const next = route[routeIndex];
      actor.rotation.y = Math.atan2(next.x - actor.position.x, next.z - actor.position.z);
    }
  };

  return {
    isActive: () => direction !== null || Number.isFinite(loungeUntil),
    update: (delta) => {
      elapsed += delta;
      if (direction) {
        advanceRoute(delta);
        return;
      }
      if (elapsed + 1e-9 >= loungeUntil) {
        loungeUntil = Number.POSITIVE_INFINITY;
        startRoute("returning");
        return;
      }
      if (elapsed + 1e-9 >= nextBreakAt) startRoute("outbound");
    },
  };
}
