-- Baseline the tables that Compadre historically created at process startup.
-- IF NOT EXISTS keeps this migration safe for deployed databases that already
-- have those tables while allowing Drizzle to own all later schema changes.
CREATE TABLE IF NOT EXISTS "compadre_ai_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at_ms" bigint NOT NULL,
	"finished_at_ms" bigint,
	"error" jsonb,
	"usage" jsonb,
	"sandbox_key" text,
	"detached_since_ms" bigint,
	"cancel_requested" boolean,
	"driver_epoch" bigint,
	CONSTRAINT "compadre_ai_runs_status_check" CHECK ("status" in ('running', 'interrupted', 'completed', 'failed', 'aborted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compadre_ai_streams" (
	"run_id" text PRIMARY KEY NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compadre_ai_stream_events" (
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"chunk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compadre_ai_stream_events_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "compadre_ai_stream_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "compadre_ai_streams"("run_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compadre_pr_watches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"matched_prod_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"delivery_started_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "compadre_pr_watches_pr_number_slack_team_id_slack_channel_i_key" UNIQUE("pr_number","slack_team_id","slack_channel_id","slack_thread_ts"),
	CONSTRAINT "compadre_pr_watches_pr_number_check" CHECK ("pr_number" > 0),
	CONSTRAINT "compadre_pr_watches_status_check" CHECK ("status" in ('waiting', 'delivering', 'notified', 'closed_unmerged'))
);
--> statement-breakpoint
ALTER TABLE "compadre_pr_watches"
	ADD COLUMN IF NOT EXISTS "delivery_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compadre_ai_runs_thread_started_idx" ON "compadre_ai_runs" ("thread_id","started_at_ms");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compadre_ai_runs_reclaimable_idx" ON "compadre_ai_runs" ("detached_since_ms") WHERE "status" = 'running' and "detached_since_ms" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compadre_pr_watches_waiting_idx" ON "compadre_pr_watches" ("created_at") WHERE "status" = 'waiting';
