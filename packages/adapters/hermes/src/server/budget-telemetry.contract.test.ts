import { describe, expect, it } from "vitest";
import { hermesBudgetTelemetry } from "./budget-telemetry.js";

function fixture() {
  return {
    version: 2 as const,
    provider: "custom",
    endpoint_class: "unknown",
    cost_status: "estimated",
    cost_source: "provider_models_api",
    estimated_cost_usd: 0.00028,
    api_calls: 2,
    successful_provider_responses: 2,
    usage_telemetry_complete: true,
    provider_request_ids: ["synthetic-fixture-1", "synthetic-fixture-2"],
    provider_input_tokens: 200,
    input_tokens: 110,
    output_tokens: 40,
  };
}

describe("managed canary production billing boundary", () => {
  it("does not accept loopback estimated usage as external billing", () => {
    expect(hermesBudgetTelemetry(fixture(), 100)).toBeUndefined();
  });

  it("does not infer zero billing from a missing terminal result", () => {
    expect(hermesBudgetTelemetry(null, 100)).toBeUndefined();
  });

  it("does not accept unknown transport outcome as a zero charge", () => {
    const result = { ...fixture(), provider_request_ids: [],
      estimated_cost_usd: 0, usage_telemetry_complete: false };
    expect(hermesBudgetTelemetry(result, 100)).toBeUndefined();
  });

  it("does not certify a custom estimate by changing its cost-status label", () => {
    const result = { ...fixture(), cost_status: "actual" };
    expect(hermesBudgetTelemetry(result, 100)).toBeUndefined();
  });

  it("retains the existing included-subscription boundary", () => {
    const result = { ...fixture(), provider: "openai-codex",
      cost_status: "included", cost_source: "none", estimated_cost_usd: 0 };
    expect(hermesBudgetTelemetry(result, 100)).toMatchObject({
      inputTokens: 200, outputTokens: 40, costMicrousd: 0,
      rateCardVersion: "openai-codex-subscription-v1",
    });
  });
});
