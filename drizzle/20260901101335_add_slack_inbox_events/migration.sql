CREATE TABLE "compadre_slack_inbox_events" (
	"event_key" text PRIMARY KEY,
	"team_id" text,
	"bot_user_id" text,
	"event" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compadre_slack_inbox_events_status_check" CHECK ("status" in ('queued', 'processing', 'done', 'dead')),
	CONSTRAINT "compadre_slack_inbox_events_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "compadre_slack_inbox_events_claimable_idx" ON "compadre_slack_inbox_events" ("status","next_attempt_at");