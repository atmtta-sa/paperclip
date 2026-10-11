CREATE TABLE "automatic_successor_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "issue_id" uuid NOT NULL REFERENCES "issues"("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "predecessor_run_id" uuid NOT NULL,
  "chain_root_run_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "reason" text NOT NULL,
  "denial_reason" text,
  "checkpoint_ref" text,
  "next_action" text,
  "authorization_binding" jsonb NOT NULL,
  "policy_version" integer NOT NULL,
  "budget_snapshot" jsonb,
  "wakeup_request_id" uuid,
  "successor_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "automatic_successor_intents_kind_check"
    CHECK ("kind" IN ('productive', 'corrective', 'recovery')),
  CONSTRAINT "automatic_successor_intents_status_check"
    CHECK ("status" IN ('pending', 'materialized', 'denied', 'cancelled'))
);
CREATE UNIQUE INDEX "automatic_successor_intents_predecessor_uq"
  ON "automatic_successor_intents" USING btree ("company_id", "predecessor_run_id");
CREATE INDEX "automatic_successor_intents_pending_idx"
  ON "automatic_successor_intents" USING btree ("company_id", "status", "created_at");
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. This release introduces the automatic-successor key namespace, so deployed databases have no matching rows before this required atomic-deduplication index is added.
CREATE UNIQUE INDEX "agent_wakeup_requests_automatic_successor_idempotency_uq"
  ON "agent_wakeup_requests" USING btree ("company_id", "idempotency_key")
  WHERE "idempotency_key" LIKE 'automatic-successor:%';
