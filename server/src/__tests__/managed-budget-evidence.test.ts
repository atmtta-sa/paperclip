import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { verifyManagedBudgetEvidence, resolveManagedBudgetVerifier } from "../services/managed-budget-evidence.js";

const telemetry = {
  providerRequestId: "synthetic-response-1", requestCount: 2,
  inputTokens: 200, outputTokens: 40, runtimeMs: 100,
  costMicrousd: 280, rateCardVersion: "synthetic-fixture-v1",
};
function result(): AdapterExecutionResult {
  return {
    exitCode: 0, signal: null, timedOut: false,
    usageBasis: "per_run", usage: { inputTokens: 200, outputTokens: 40 },
    budgetTelemetry: telemetry,
    resultJson: {
      provider: "custom", billingType: "unknown", apiCalls: 2,
      successfulProviderResponses: 2, usageTelemetryComplete: true,
      budgetTelemetryComplete: true, costStatus: "estimated",
      costUnavailableReason: null, cost_usd: 0.00028,
      providerRequestIds: ["synthetic-response-1", "synthetic-response-2"],
    },
  };
}
describe("managed settlement evidence boundary", () => {
  it("rejects synthetic estimates even with exact usage and nominal telemetry", () => {
    const input = result();
    expect(verifyManagedBudgetEvidence(input, input.usage!)).toBeNull();
  });
  it("preserves subscription-included evidence with matching per-run usage", () => {
    const input = result();
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: 0,
    });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, input.usage!)).toEqual(input.budgetTelemetry);
  });
  it("rejects token contradictions even for subscription evidence", () => {
    const input = result();
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: 0,
    });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, { inputTokens: 201, outputTokens: 40 })).toBeNull();
  });
  it("keeps missing usage evidence uncertain", () => {
    const input = result();
    Object.assign(input.resultJson!, { usageTelemetryComplete: false, budgetTelemetryComplete: false });
    expect(verifyManagedBudgetEvidence(input, null)).toBeNull();
  });
  it.each([
    { complete: false, terminalDiscrepancies: [] },
    { complete: true, terminalDiscrepancies: ["input_tokens"] },
  ])("retains uncertainty or contradiction in durable evidence", (durableCallEvidence) => {
    const input = result();
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: 0,
      durableCallEvidence,
    });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, input.usage!)).toBeNull();
  });

  it("uses the production verifier by default", () => {
    expect(resolveManagedBudgetVerifier(undefined, "production")).toBe(verifyManagedBudgetEvidence);
  });
  it("refuses a test verifier outside test mode", () => {
    expect(() => resolveManagedBudgetVerifier(() => telemetry, "production"))
      .toThrow("managed_budget_test_verifier_forbidden");
    expect(() => resolveManagedBudgetVerifier(() => telemetry, undefined))
      .toThrow("managed_budget_test_verifier_forbidden");
  });
  it("permits an explicit fixture verifier only in test mode", () => {
    const fixtureVerifier = () => telemetry;
    expect(resolveManagedBudgetVerifier(fixtureVerifier, "test")).toBe(fixtureVerifier);
  });
});
