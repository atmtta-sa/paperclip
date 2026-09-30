import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveUserHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  return path.resolve(asString(env.HOME) ?? os.homedir());
}

export function resolveManagedHermesProfile(
  config: Record<string, unknown>,
): string {
  const profile = asString(config.hermesProfile);
  if (
    !profile ||
    profile === "default" ||
    !SAFE_PROFILE_NAME.test(profile)
  ) {
    throw new Error("hermes_managed_profile_invalid");
  }
  return profile;
}

export function resolveHermesProfileHome(
  config: Record<string, unknown>,
): string {
  return path.join(
    resolveUserHome(config),
    ".hermes",
    "profiles",
    resolveManagedHermesProfile(config),
  );
}

export async function requireManagedHermesProfile(
  config: Record<string, unknown>,
): Promise<string> {
  const profile = resolveManagedHermesProfile(config);
  try {
    const profileStat = await fs.lstat(resolveHermesProfileHome(config));
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
      throw new Error("unsafe profile path");
    }
  } catch {
    throw new Error("hermes_managed_profile_missing");
  }
  return profile;
}
