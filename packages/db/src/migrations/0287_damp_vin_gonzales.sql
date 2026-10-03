ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "settlement_state" text;--> statement-breakpoint
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "overrun_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "autonomous_budget_reservations"
SET "overrun_input_tokens" = GREATEST("actual_input_tokens" - "reserved_input_tokens", 0)
WHERE "status" = 'reconciled'
  AND "actual_input_tokens" IS NOT NULL;--> statement-breakpoint
UPDATE "autonomous_budget_reservations"
SET "settlement_state" = CASE
  WHEN "status" = 'released' THEN 'released_zero_usage'
  WHEN "status" = 'retained_missing_telemetry' THEN 'uncertain_requires_reconciliation'
  WHEN
    COALESCE("actual_request_count", 0) > "reserved_request_count"
    OR COALESCE("actual_input_tokens", 0) > "reserved_input_tokens"
    OR COALESCE("actual_output_tokens", 0) > "reserved_output_tokens"
    OR COALESCE("actual_runtime_ms", 0) > "reserved_runtime_ms"
    OR COALESCE("actual_cost_microusd", 0) > "reserved_cost_microusd"
    THEN 'consumed_over_reservation'
  WHEN
    COALESCE("actual_request_count", 0) < "reserved_request_count"
    OR COALESCE("actual_input_tokens", 0) < "reserved_input_tokens"
    OR COALESCE("actual_output_tokens", 0) < "reserved_output_tokens"
    OR COALESCE("actual_runtime_ms", 0) < "reserved_runtime_ms"
    OR COALESCE("actual_cost_microusd", 0) < "reserved_cost_microusd"
    THEN 'partially_consumed'
  ELSE 'consumed'
END
WHERE "status" <> 'reserved';
