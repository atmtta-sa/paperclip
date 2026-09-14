import type * as THREE from "three";
import type { OfficeState } from "../projection.js";

export interface StatusLightProfile {
  speed: number;
  minIntensity: number;
  maxIntensity: number;
}

const CHANNEL_COLORS: Readonly<Record<string, number>> = {
  paperclip: 0x38bdf8,
  codex: 0xa78bfa,
  hermes: 0xf97316,
};

const ANIMATION_CANDIDATES: Readonly<Record<OfficeState, readonly string[]>> = {
  idle: ["sit", "idle"],
  thinking: ["idle", "sit"],
  executing: ["interact-right", "sit", "idle"],
  waiting: ["sit", "idle"],
  error: ["crouch", "idle", "sit"],
};

const STATUS_LIGHT_PROFILES: Readonly<Record<OfficeState, StatusLightProfile>> = {
  idle: { speed: 0, minIntensity: 0.9, maxIntensity: 0.9 },
  thinking: { speed: 0.8, minIntensity: 0.78, maxIntensity: 1.08 },
  executing: { speed: 1.6, minIntensity: 0.72, maxIntensity: 1.2 },
  waiting: { speed: 0.5, minIntensity: 0.76, maxIntensity: 1.12 },
  error: { speed: 1.2, minIntensity: 0.62, maxIntensity: 1.28 },
};

export function channelHaloColor(channel: string): number {
  return CHANNEL_COLORS[channel.trim().toLowerCase()] ?? 0xec4899;
}

export function resolveAnimationClip(
  state: OfficeState,
  clips: readonly THREE.AnimationClip[],
): THREE.AnimationClip | undefined {
  const clipsByName = new Map(clips.map((clip) => [clip.name.toLowerCase(), clip]));
  for (const candidate of ANIMATION_CANDIDATES[state]) {
    const clip = clipsByName.get(candidate);
    if (clip) return clip;
  }
  return clipsByName.get("idle") ?? clipsByName.get("sit") ?? clips[0];
}

export function statusLightProfile(state: OfficeState): StatusLightProfile {
  return STATUS_LIGHT_PROFILES[state];
}
