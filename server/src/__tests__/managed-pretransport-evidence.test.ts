import { describe, expect, it } from "vitest";
import { verifyManagedPretransportEvidence } from "../services/managed-pretransport-evidence.js";

function result() {
  return { exitCode: 1, signal: null, timedOut: false,
    errorCode: "managed_progress_policy_invalid", retryHint: "non_retryable" as const,
    resultJson: { turn_exit_reason: "managed_progress_policy_invalid", successfulProviderResponses: 0,
      pretransportEvidence: { version: 1, source: "hermes_sqlite_transport_owner", runId: "run-A",
        sessionId: "shared", attestationId: "attestation-A", startedAt: 1, sealedAt: 2,
        boundary: "never_crossed", complete: true, terminalReason: "managed_progress_policy_invalid" } } };
}

describe("managed pre-transport settlement evidence", () => {
  it("rejects legacy v1 transport-owner evidence for new successor authority", () => {
    expect(verifyManagedPretransportEvidence(result(), "run-A")).toBe(false);
  });
  it.each([
    { runId: "run-B" }, { complete: false }, { source: "agent_claim" },
    { boundary: "unknown" }, { sealedAt: 0 }, { attestationId: "" },
    { terminalReason: "no_progress" }, { version: 2 },
  ])("rejects invalid or mismatched attestation %j", (change) => {
    const value = result();
    Object.assign(value.resultJson.pretransportEvidence, change);
    expect(verifyManagedPretransportEvidence(value, "run-A")).toBe(false);
  });
  it.each([
    { pretransportEvidence: null }, { durableCallEvidence: { confirmedResponses: 1 } },
    { successfulProviderResponses: 1 }, { providerRequestIds: ["response-A"] },
    { turn_exit_reason: "no_progress" }, { cost_usd: 0.001 },
  ])("retains uncertainty for absent or conflicting result evidence %j", (change) => {
    const value = result();
    Object.assign(value.resultJson, change);
    expect(verifyManagedPretransportEvidence(value, "run-A")).toBe(false);
  });
  it("cannot erase confirmed adapter usage", () => {
    expect(verifyManagedPretransportEvidence({ ...result(), usage: { inputTokens: 10, outputTokens: 2 } }, "run-A")).toBe(false);
  });
});
