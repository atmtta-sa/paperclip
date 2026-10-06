import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDurableHermesCallEvidence } from "./durable-call-evidence.js";

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "hermes-run-evidence-test-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(`CREATE TABLE provider_transport_attempts (
    attempt_id TEXT, execution_run_id TEXT, session_id TEXT, sequence INTEGER,
    state TEXT, provider_request_id TEXT, provider TEXT, model TEXT,
    billing_base_url TEXT, pricing_json TEXT, started_at REAL);
    CREATE TABLE provider_call_usage (
    session_id TEXT, sequence INTEGER, provider_request_id TEXT,
    provider TEXT, model TEXT, billing_base_url TEXT, input_tokens INTEGER,
    output_tokens INTEGER, runtime_ms INTEGER, cost_usd REAL, cost_status TEXT);`);
  const rate = JSON.stringify({ rate_card_id: "a".repeat(64), currency: "USD" });
  const attempt = db.prepare("INSERT INTO provider_transport_attempts VALUES (?, ?, 'shared', ?, ?, ?, 'custom', 'fixture', 'http://127.0.0.1:12345/v1', ?, 1)");
  const call = db.prepare("INSERT INTO provider_call_usage VALUES ('shared', ?, ?, 'custom', 'fixture', 'http://127.0.0.1:12345/v1', ?, 20, 1, 0.00014, 'estimated')");
  attempt.run("attempt-A", "run-A", 1, "completed", "synthetic-A", rate);
  call.run(1, "synthetic-A", 100);
  attempt.run("attempt-B", "run-B", 2, "completed", "synthetic-B", rate);
  call.run(2, "synthetic-B", 50);
  db.close();
  return home;
}

describe("read-only durable managed evidence", () => {
  it("recovers only the exact run from a shared session without terminal output", () => {
    const evidence = readDurableHermesCallEvidence(fixture(), "run-A");
    expect(evidence).toMatchObject({ runId: "run-A", complete: true,
      requestCount: 1, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.00014,
      externalBillingVerified: false });
    expect(evidence?.providerRequestIds).toEqual(["synthetic-A"]);
  });
  it("does not certify absent run evidence as zero transport", () => {
    expect(readDurableHermesCallEvidence(fixture(), "missing-run")).toBeNull();
  });
  it("preserves confirmed usage beside an uncertain transport attempt", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec("INSERT INTO provider_transport_attempts (attempt_id,execution_run_id,session_id,state,started_at) VALUES ('unknown','run-A','shared','started',2)");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({
      complete: false, requestCount: 2, confirmedResponses: 1, inputTokens: 100,
      outputTokens: 20, estimatedCostUsd: null, externalBillingVerified: false,
    });
  });
  it("flags a contradictory terminal total without discarding the ledger", () => {
    expect(readDurableHermesCallEvidence(fixture(), "run-A", {
      provider_input_tokens: 999, output_tokens: 20, successful_provider_responses: 1,
    })).toMatchObject({ inputTokens: 100, terminalDiscrepancies: ["input_tokens"] });
  });
  it("does not complete evidence whose aggregate tokens exceed safe integer range", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "b".repeat(64), currency: "USD" });
    db.prepare("UPDATE provider_call_usage SET input_tokens = ? WHERE provider_request_id = 'synthetic-A'")
      .run(Number.MAX_SAFE_INTEGER);
    db.prepare("INSERT INTO provider_transport_attempts VALUES ('attempt-C', 'run-A', 'shared', 3, 'completed', 'synthetic-C', 'custom', 'fixture', 'http://127.0.0.1:12345/v1', ?, 3)")
      .run(rate);
    db.exec("INSERT INTO provider_call_usage VALUES ('shared', 3, 'synthetic-C', 'custom', 'fixture', 'http://127.0.0.1:12345/v1', 1, 0, 1, 0.00001, 'estimated')");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({ complete: false });
  });
  it("does not complete evidence with an empty provider request identity", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec("UPDATE provider_transport_attempts SET provider_request_id = '' WHERE execution_run_id = 'run-A'; UPDATE provider_call_usage SET provider_request_id = '' WHERE provider_request_id = 'synthetic-A'");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({ complete: false });
  });
  it("does not emit an infinite aggregate estimated cost", () => {
    const home = fixture();
    const db = new DatabaseSync(path.join(home, "state.db"));
    const rate = JSON.stringify({ rate_card_id: "c".repeat(64), currency: "USD" });
    db.exec("UPDATE provider_call_usage SET cost_usd = 1e308 WHERE provider_request_id = 'synthetic-A'");
    db.prepare("INSERT INTO provider_transport_attempts VALUES ('attempt-D', 'run-A', 'shared', 4, 'completed', 'synthetic-D', 'custom', 'fixture', 'http://127.0.0.1:12345/v1', ?, 4)")
      .run(rate);
    db.exec("INSERT INTO provider_call_usage VALUES ('shared', 4, 'synthetic-D', 'custom', 'fixture', 'http://127.0.0.1:12345/v1', 1, 0, 1, 1e308, 'estimated')");
    db.close();
    expect(readDurableHermesCallEvidence(home, "run-A")).toMatchObject({ estimatedCostUsd: null });
  });
});
