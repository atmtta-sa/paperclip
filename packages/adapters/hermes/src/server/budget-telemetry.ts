import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

type HermesChargeEvidence = {
  version: 1 | 2;
  provider?: string | null;
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
  if (result?.version !== 2 ||
      !Array.isArray(result.provider_request_ids) ||
      result.provider_request_ids.length === 0 ||
      result.provider_request_ids.some((id) => id.startsWith("stream-")) ||
      result.input_tokens == null || result.output_tokens == null ||
      !Number.isSafeInteger(runtimeMs) || runtimeMs < 0) return undefined;

  if (result.provider === "openai-codex" && result.cost_status === "included" &&
      result.cost_source === "none" && !result.cost_unavailable_reason &&
      result.estimated_cost_usd === 0 && Number.isSafeInteger(result.api_calls) &&
      Number.isSafeInteger(result.successful_provider_responses) &&
      (result.successful_provider_responses ?? 0) >= 1 &&
      (result.api_calls ?? 0) >= (result.successful_provider_responses ?? 0) &&
      result.provider_request_ids.length === result.successful_provider_responses) {
    return {
      providerRequestId: result.provider_request_ids[0],
      requestCount: result.api_calls!,
      inputTokens: result.input_tokens, outputTokens: result.output_tokens,
      runtimeMs, costMicrousd: 0,
      rateCardVersion: "openai-codex-subscription-v1",
    };
  }

  if (result.successful_provider_responses !== 1 ||
      result.provider_request_ids.length !== 1 ||
      result.endpoint_class !== "openrouter_api" || result.cost_status !== "actual" ||
      result.cost_source !== "provider_cost_api" || result.cost_unavailable_reason ||
      result.api_calls !== 1 || !result.usage_telemetry_complete ||
      result.estimated_cost_usd == null) return undefined;
  const costMicrousd = Math.round(result.estimated_cost_usd * 1_000_000);
  if (!Number.isSafeInteger(costMicrousd)) return undefined;
  return {
    providerRequestId: result.provider_request_ids[0], requestCount: 1,
    inputTokens: result.input_tokens, outputTokens: result.output_tokens,
    runtimeMs, costMicrousd,
  };
}
