import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { verifyManagedBudgetEvidence, resolveManagedBudgetVerifier } from "../services/managed-budget-evidence.js";

const telemetry = {
  providerRequestId: "synthetic-response-1", requestCount: 2,
  inputTokens: 200, outputTokens: 40, runtimeMs: 100,
  costMicrousd: 280, rateCardVersion: "synthetic-fixture-v1",
};
const completeDurableEvidence = {
  status: "complete", source: "hermes_sqlite_transport_owner", contractVersion: 2,
  runId: "synthetic-run", complete: true, iterationAttempts: 3,
  providerDispatches: 2, confirmedResponses: 2, pretransportDenials: 1,
  unknownOutcomes: 0, requestCount: 2, inputTokens: 200, outputTokens: 40,
  providerRequestIds: ["synthetic-response-1", "synthetic-response-2"],
  providerRuntimeMs: 100, runtimeBasis: "confirmed_provider_call_ms_v1",
  costMicrousd: 280, costBasis: "provider_actual",
  costAuthority: "provider_usage_response",
  costAuthorityRef: "synthetic-response-1", estimatedCostUsd: 0,
  terminalDiscrepancies: [],
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
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run")).toBeNull();
  });
  it("rejects self-asserted subscription authority without an independent artifact", () => {
    const input = result();
    const subscriptionEvidence = {
      ...completeDurableEvidence,
      costMicrousd: 0,
      costBasis: "subscription_included",
      costAuthority: "openai_codex_authenticated_subscription",
    };
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: 0,
      durableCallEvidence: subscriptionEvidence,
    });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run"))
      .toBeNull();
  });
  it("rejects legacy subscription labels when v2 evidence is omitted", () => {
    const input = result();
    input.resultJson = {
      provider: "openai-codex", billingType: "subscription",
      budgetTelemetryComplete: true, costStatus: "included",
      costUnavailableReason: null, cost_usd: 0,
      apiCalls: 2, successfulProviderResponses: 2,
      providerRequestIds: ["synthetic-response-1", "synthetic-response-2"],
    };
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run"))
      .toBeNull();
  });
  it.each([
    ["provider_actual", "openai_codex_authenticated_subscription"],
    ["subscription_included", "provider_usage_response"],
  ])("rejects mismatched cost authority %s / %s", (costBasis, costAuthority) => {
    const input = result();
    input.resultJson = { durableCallEvidence: { ...completeDurableEvidence, costBasis, costAuthority } };
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run")).toBeNull();
  });
  it("rejects durable evidence attributed to a different run", () => {
    const input = result();
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: 0,
      durableCallEvidence: completeDurableEvidence,
    });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(input, input.usage!, "different-run")).toBeNull();
  });
  it("rejects token contradictions even for subscription evidence", () => {
    const input = result();
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: 0,
      durableCallEvidence: completeDurableEvidence,
    });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0 };
    expect(verifyManagedBudgetEvidence(
      input, { inputTokens: 201, outputTokens: 40 }, "synthetic-run",
    )).toBeNull();
  });
  it("rejects child runtime telemetry that disagrees with durable provider runtime", () => {
    const input = result();
    Object.assign(input.resultJson!, { durableCallEvidence: completeDurableEvidence });
    input.budgetTelemetry = { ...telemetry, costMicrousd: 0, runtimeMs: 101 };
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run")).toBeNull();
  });
  it.each([
    { name: "blank provider identity", requestId: " ", cost: 0 },
    { name: "negative cost", requestId: "synthetic-response-1", cost: -0.000001 },
    { name: "non-finite cost", requestId: "synthetic-response-1", cost: Number.NaN },
  ])("rejects $name in durable evidence", ({ requestId, cost }) => {
    const input = result();
    const durableCallEvidence = {
      ...completeDurableEvidence,
      providerRequestIds: [requestId, "synthetic-response-2"],
      estimatedCostUsd: cost,
    };
    Object.assign(input.resultJson!, {
      provider: "openai-codex", billingType: "subscription", costStatus: "included", cost_usd: cost,
      durableCallEvidence,
    });
    input.budgetTelemetry = {
      ...telemetry, providerRequestId: requestId,
      costMicrousd: Math.round(cost * 1_000_000),
    };
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run")).toBeNull();
  });
  it("keeps missing usage evidence uncertain", () => {
    const input = result();
    Object.assign(input.resultJson!, { usageTelemetryComplete: false, budgetTelemetryComplete: false });
    expect(verifyManagedBudgetEvidence(input, null, "synthetic-run")).toBeNull();
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
    expect(verifyManagedBudgetEvidence(input, input.usage!, "synthetic-run")).toBeNull();
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
