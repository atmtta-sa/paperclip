CREATE TABLE "autonomous_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_request_count" integer DEFAULT 0 NOT NULL,
	"reserved_input_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_output_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_runtime_ms" bigint DEFAULT 0 NOT NULL,
	"reserved_cost_cents" integer DEFAULT 0 NOT NULL,
	"actual_request_count" integer,
	"actual_input_tokens" bigint,
	"actual_output_tokens" bigint,
	"actual_runtime_ms" bigint,
	"actual_cost_cents" integer,
	"provider" text,
	"model" text,
	"credential_identifier_hash" text,
	"rate_card_version" text,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autonomous_budget_reservations" ADD CONSTRAINT "autonomous_budget_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_budget_reservations" ADD CONSTRAINT "autonomous_budget_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_budget_reservations" ADD CONSTRAINT "autonomous_budget_reservations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_budget_reservations_run_uq" ON "autonomous_budget_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "autonomous_budget_reservations_company_created_idx" ON "autonomous_budget_reservations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "autonomous_budget_reservations_task_created_idx" ON "autonomous_budget_reservations" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "autonomous_budget_reservations_agent_created_idx" ON "autonomous_budget_reservations" USING btree ("company_id","agent_id","created_at");