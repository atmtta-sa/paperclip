import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDurableHermesPretransportEvidence } from "./pretransport-evidence.js";

function fixture(state = "sealed_no_transport") {
  const home = mkdtempSync(path.join(tmpdir(), "hermes-pretransport-test-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(`CREATE TABLE managed_transport_runs (execution_run_id TEXT, session_id TEXT,
    provider TEXT, model TEXT, state TEXT, started_at REAL, sealed_at REAL,
    terminal_reason TEXT, attestation_id TEXT);
    CREATE TABLE provider_transport_attempts (execution_run_id TEXT, state TEXT);`);
  db.prepare("INSERT INTO managed_transport_runs VALUES ('run-A', 'shared', 'custom', 'fixture', ?, 1, 2, 'managed_progress_policy_invalid', 'attestation-A')").run(state);
  db.close();
  return home;
}

describe("positive managed pre-transport evidence", () => {
  it("accepts a completed exact-run attestation, not an empty ledger inference", () => {
    expect(readDurableHermesPretransportEvidence(fixture(), "run-A", null)).toMatchObject({
      version: 1, runId: "run-A", sessionId: "shared", attestationId: "attestation-A",
      boundary: "never_crossed", complete: true, terminalReason: "managed_progress_policy_invalid",
    });
  });
  it("rejects absent or unfinished run evidence", () => {
    expect(readDurableHermesPretransportEvidence(fixture(), "missing", null)).toBeNull();
    expect(readDurableHermesPretransportEvidence(fixture("started"), "run-A", null)).toBeNull();
  });
  it.each(["started", "completed"])("rejects a %s transport attempt", (state) => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.prepare("INSERT INTO provider_transport_attempts VALUES ('run-A', ?)").run(state);
    db.close();
    expect(readDurableHermesPretransportEvidence(home, "run-A", null)).toBeNull();
  });
  it("rejects contradictory terminal usage or cause", () => {
    expect(readDurableHermesPretransportEvidence(fixture(), "run-A", { successful_provider_responses: 1 })).toBeNull();
    expect(readDurableHermesPretransportEvidence(fixture(), "run-A", { turn_exit_reason: "no_progress" })).toBeNull();
  });
});
