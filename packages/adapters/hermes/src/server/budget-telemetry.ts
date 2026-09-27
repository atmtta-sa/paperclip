import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

type HermesChargeEvidence = {
  version: 1 | 2;
  endpoint_class?: string;
  cost_status?: string | null;
  cost_source?: string | null;
  cost_unavailable_reason?: string | null;
  estimated_cost_usd?: number | null;
  api_calls?: number;
  successful_provider_responses?: number;
  usage_telemetry_complete?: boolean;
  provider_request_ids?: string[];
  input_tokens?: number | null;
  output_tokens?: number | null;
};

export function hermesBudgetTelemetry(
  result: HermesChargeEvidence | null,
  runtimeMs: number,
): AdapterExecutionResult["budgetTelemetry"] {
  if (result?.version !== 2 || result.endpoint_class !== "openrouter_api" ||
      result.cost_status !== "actual" || result.cost_source !== "provider_cost_api" ||
      result.cost_unavailable_reason || result.api_calls !== 1 ||
      result.successful_provider_responses !== 1 || !result.usage_telemetry_complete ||
      result.provider_request_ids?.length !== 1 ||
      result.provider_request_ids[0].startsWith("stream-") ||
      result.input_tokens == null || result.output_tokens == null ||
      result.estimated_cost_usd == null) return undefined;
  const costMicrousd = Math.round(result.estimated_cost_usd * 1_000_000);
  if (!Number.isSafeInteger(costMicrousd) || !Number.isSafeInteger(runtimeMs) || runtimeMs < 0) {
    return undefined;
  }
  return {
    providerRequestId: result.provider_request_ids[0], requestCount: 1,
    inputTokens: result.input_tokens, outputTokens: result.output_tokens,
    runtimeMs, costMicrousd,
  };
}
