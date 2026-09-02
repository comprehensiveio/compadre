CREATE TABLE "compadre_triggered_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"trigger_type" text DEFAULT 'cron' NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"delivery_mode" text DEFAULT 'new_thread' NOT NULL,
	"slack_channel_id" text,
	"target_thread_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_central_thread_id" text,
	CONSTRAINT "compadre_triggered_prompts_delivery_mode_check" CHECK ("delivery_mode" in ('new_thread', 'same_thread', 'existing_thread'))
);
