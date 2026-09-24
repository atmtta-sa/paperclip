ALTER TABLE "heartbeat_runs" ADD COLUMN "work_outcome" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "state_fingerprint_before" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "state_fingerprint_after" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "no_progress_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "continuity_circuit_state" text DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "continuity_circuit_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "continuity_circuit_alerted_at" timestamp with time zone;