CREATE TABLE "compadre_slack_turn_deliveries" (
	"id" uuid PRIMARY KEY,
	"message_id" text NOT NULL CONSTRAINT "compadre_slack_turn_deliveries_message_id_key" UNIQUE,
	"canonical_thread_id" text NOT NULL,
	"t3_thread_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"dispatch_sequence" bigint NOT NULL,
	"dispatch_created_at" timestamp with time zone NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"trigger_message_ts" text NOT NULL,
	"recipient_user_id" text,
	"details_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compadre_slack_turn_deliveries_status_check" CHECK ("status" in ('pending', 'delivering', 'delivered', 'dead')),
	CONSTRAINT "compadre_slack_turn_deliveries_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "compadre_slack_turn_deliveries_ready_idx" ON "compadre_slack_turn_deliveries" ("next_attempt_at","created_at") WHERE "status" in ('pending', 'delivering');