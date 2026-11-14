type JsonRecord = Record<string, unknown>;

export type HermesEffectiveRequestPolicy = {
  required: boolean;
  maxRequestBytes: number;
  maxSystemBytes: number;
  maxMessagesBytes: number;
  maxToolsBytes: number;
  maxToolCount: number;
  maxExactDuplicateBlocks: number;
  minDuplicateBlockBytes: number;
};

export type HermesContextTelemetry = {
  schema: "hermes.context_telemetry.v1";
  request_count: number;
  verdict: "allowed" | "denied";
  reason: string | null;
  requests: JsonRecord[];
};

const POLICY_KEYS = [
  "maxExactDuplicateBlocks",
  "maxMessagesBytes",
  "maxRequestBytes",
  "maxSystemBytes",
  "maxToolCount",
  "maxToolsBytes",
  "minDuplicateBlockBytes",
  "required",
];
const TELEMETRY_KEYS = ["reason", "request_count", "requests", "schema", "verdict"];
const MANIFEST_KEYS = [
  "duplicate_blocks",
  "hashes",
  "measurements",
  "model",
  "policy_sha256",
  "provider",
  "reason",
  "schema",
  "transport",
  "verdict",
];
const MEASUREMENT_KEYS = [
  "message_count",
  "messages_bytes",
  "request_bytes",
  "system_bytes",
  "tool_count",
  "tools_bytes",
];
const HASH_KEYS = [
  "messages_sha256",
  "request_sha256",
  "system_sha256",
  "tools_sha256",
];
const DUPLICATE_KEYS = ["bytes", "occurrences", "sha256"];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === keys.join(",");
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validReason(value: unknown, verdict: unknown): value is string | null {
  return verdict === "allowed"
    ? value === null
    : verdict === "denied" && typeof value === "string" && /^effective_request_[a-z_]+$/.test(value);
}

export function resolveEffectiveRequestPolicy(
  config: Record<string, unknown>,
): HermesEffectiveRequestPolicy | undefined {
  const raw = config.effectiveRequestPolicy;
  if (raw == null) return undefined;
  if (!isRecord(raw) || !hasExactKeys(raw, POLICY_KEYS) ||
      typeof raw.required !== "boolean") {
    throw new Error("effective_request_policy_invalid");
  }
  const positiveKeys = [
    "maxRequestBytes", "maxSystemBytes", "maxMessagesBytes",
    "maxToolsBytes", "minDuplicateBlockBytes",
  ];
  const nonnegativeKeys = ["maxToolCount", "maxExactDuplicateBlocks"];
  if (positiveKeys.some((key) => !isPositiveInteger(raw[key])) ||
      nonnegativeKeys.some((key) => !isNonnegativeInteger(raw[key]))) {
    throw new Error("effective_request_policy_invalid");
  }
  return raw as HermesEffectiveRequestPolicy;
}

function validMeasurements(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, MEASUREMENT_KEYS) &&
    MEASUREMENT_KEYS.every((key) => isNonnegativeInteger(value[key]));
}

function validHashes(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, HASH_KEYS) &&
    HASH_KEYS.every((key) => isSha256(value[key]));
}

function validDuplicate(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, DUPLICATE_KEYS) &&
    isSha256(value.sha256) && isPositiveInteger(value.bytes) &&
    isNonnegativeInteger(value.occurrences) && value.occurrences >= 2;
}

function validManifest(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) return false;
  if (value.schema !== "hermes.effective_request_manifest.v1" ||
      !["chat_completions", "codex_responses"].includes(String(value.transport)) ||
      typeof value.provider !== "string" || !value.provider ||
      typeof value.model !== "string" || !value.model ||
      !validMeasurements(value.measurements) || !validHashes(value.hashes) ||
      !isSha256(value.policy_sha256) || !Array.isArray(value.duplicate_blocks) ||
      !value.duplicate_blocks.every(validDuplicate)) return false;
  return validReason(value.reason, value.verdict);
}

export function parseContextTelemetry(value: unknown): HermesContextTelemetry | undefined {
  if (value == null) return undefined;
  if (!isRecord(value) || !hasExactKeys(value, TELEMETRY_KEYS) ||
      value.schema !== "hermes.context_telemetry.v1" ||
      !isNonnegativeInteger(value.request_count) || value.request_count === 0 ||
      value.request_count > 100 || !Array.isArray(value.requests) ||
      value.requests.length !== value.request_count ||
      !value.requests.every(validManifest) ||
      !validReason(value.reason, value.verdict)) return undefined;
  const requestVerdicts = value.requests.map((request) => request.verdict);
  if (value.verdict === "allowed" && requestVerdicts.some((verdict) => verdict !== "allowed")) {
    return undefined;
  }
  if (value.verdict === "denied" && !requestVerdicts.includes("denied")) return undefined;
  return value as HermesContextTelemetry;
}
