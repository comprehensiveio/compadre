CREATE TABLE "compadre_user_identities" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_workspace_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compadre_user_identities_provider_subject_key" UNIQUE("provider","provider_workspace_id","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "compadre_users" (
	"id" uuid PRIMARY KEY,
	"display_name" text NOT NULL,
	"real_name" text,
	"avatar_url" text,
	"email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compadre_users_status_check" CHECK ("status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX "compadre_user_identities_user_idx" ON "compadre_user_identities" ("user_id");--> statement-breakpoint
ALTER TABLE "compadre_user_identities" ADD CONSTRAINT "compadre_user_identities_user_id_compadre_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "compadre_users"("id") ON DELETE CASCADE;