import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export type HermesPretransportEvidence = {
  version: 1;
  source: "hermes_sqlite_transport_owner";
  runId: string;
  sessionId: string;
  attestationId: string;
  startedAt: number;
  sealedAt: number;
  boundary: "never_crossed";
  complete: true;
  terminalReason: "managed_progress_policy_invalid";
};

function terminalAgrees(terminal: unknown): boolean {
  if (terminal == null) return true;
  if (typeof terminal !== "object" || Array.isArray(terminal)) return false;
  const value = terminal as Record<string, unknown>;
  if (value.turn_exit_reason != null && value.turn_exit_reason !== "managed_progress_policy_invalid") return false;
  return ["successful_provider_responses", "provider_input_tokens", "input_tokens", "output_tokens"]
    .every((key) => value[key] == null || value[key] === 0);
}

/** Only a sealed transport-owner run can certify zero; missing/old stores fail closed. */
export function readDurableHermesPretransportEvidence(
  home: string, runId: string, terminal: unknown,
): HermesPretransportEvidence | null {
  let db: DatabaseSync | undefined;
  try {
    const target = path.join(home, "state.db");
    if (!runId || !terminalAgrees(terminal) || !lstatSync(target).isFile() ||
        path.dirname(realpathSync(target)) !== realpathSync(home)) return null;
    db = new DatabaseSync(target, { readOnly: true });
    db.exec("BEGIN");
    const row = db.prepare(`SELECT * FROM managed_transport_runs r WHERE execution_run_id = ?
      AND state = 'sealed_no_transport' AND NOT EXISTS
      (SELECT 1 FROM provider_transport_attempts t WHERE t.execution_run_id = r.execution_run_id)`).get(runId);
    if (!row || row.terminal_reason !== "managed_progress_policy_invalid" ||
        typeof row.session_id !== "string" || !row.session_id ||
        typeof row.attestation_id !== "string" || !row.attestation_id ||
        typeof row.started_at !== "number" || !Number.isFinite(row.started_at) || row.started_at <= 0 ||
        typeof row.sealed_at !== "number" || !Number.isFinite(row.sealed_at) || row.sealed_at < row.started_at) return null;
    db.exec("COMMIT");
    return { version: 1, source: "hermes_sqlite_transport_owner", runId,
      sessionId: row.session_id, attestationId: row.attestation_id,
      startedAt: row.started_at, sealedAt: row.sealed_at,
      boundary: "never_crossed", complete: true, terminalReason: "managed_progress_policy_invalid" };
  } catch { return null; }
  finally { db?.close(); }
}
