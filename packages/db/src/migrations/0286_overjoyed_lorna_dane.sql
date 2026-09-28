CREATE TABLE "autonomous_provider_circuits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"credential_identifier_hash" text NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"next_probe_at" timestamp with time zone,
	"probe_run_id" uuid,
	"probe_claimed_at" timestamp with time zone,
	"last_failure_run_id" uuid,
	"last_success_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autonomous_provider_circuits" ADD CONSTRAINT "autonomous_provider_circuits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_provider_circuits_scope_uq" ON "autonomous_provider_circuits" USING btree ("company_id","provider","credential_identifier_hash");--> statement-breakpoint
CREATE INDEX "autonomous_provider_circuits_company_state_idx" ON "autonomous_provider_circuits" USING btree ("company_id","state");