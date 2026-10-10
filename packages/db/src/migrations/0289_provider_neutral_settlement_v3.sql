ALTER TABLE "autonomous_budget_reservations" ALTER COLUMN "reserved_cost_cents" DROP NOT NULL;
ALTER TABLE "autonomous_budget_reservations" ALTER COLUMN "reserved_cost_microusd" DROP NOT NULL;
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "billing_mode" text NOT NULL DEFAULT 'metered_currency';
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "monetary_applicability" text NOT NULL DEFAULT 'applicable_per_request';
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "route_policy_id" text;
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "route_policy_version" integer;
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "route_policy_digest" text;
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "credential_principal_id" text;
ALTER TABLE "autonomous_budget_reservations" ADD COLUMN "root_chain_request_limit" integer;
ALTER TABLE "autonomous_budget_reservations" ADD CONSTRAINT "autonomous_budget_reservations_billing_mode_check"
  CHECK ("billing_mode" IN ('metered_currency', 'subscription_included'));
ALTER TABLE "autonomous_budget_reservations" ADD CONSTRAINT "autonomous_budget_reservations_monetary_applicability_check"
  CHECK ("monetary_applicability" IN ('applicable_per_request', 'not_applicable_per_request'));
ALTER TABLE "autonomous_budget_reservations" ADD CONSTRAINT "autonomous_budget_reservations_billing_shape_check"
  CHECK (
    ("billing_mode" = 'metered_currency'
      AND "monetary_applicability" = 'applicable_per_request'
      AND "reserved_cost_cents" IS NOT NULL
      AND "reserved_cost_microusd" IS NOT NULL)
    OR
    ("billing_mode" = 'subscription_included'
      AND "monetary_applicability" = 'not_applicable_per_request'
      AND "reserved_cost_cents" IS NULL
      AND "reserved_cost_microusd" IS NULL
      AND "route_policy_id" IS NOT NULL
      AND "route_policy_version" IS NOT NULL AND "route_policy_version" > 0
      AND "route_policy_digest" ~ '^[a-f0-9]{64}$'
      AND "credential_principal_id" IS NOT NULL
      AND "root_chain_request_limit" IS NOT NULL AND "root_chain_request_limit" > 0)
  );
