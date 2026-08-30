CREATE TABLE "compadre_auth_login_flows" (
	"state_hash" text PRIMARY KEY,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compadre_auth_login_grants" (
	"code_hash" text PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "compadre_auth_login_flows_expires_idx" ON "compadre_auth_login_flows" ("expires_at");--> statement-breakpoint
CREATE INDEX "compadre_auth_login_grants_expires_idx" ON "compadre_auth_login_grants" ("expires_at");--> statement-breakpoint
ALTER TABLE "compadre_auth_login_grants" ADD CONSTRAINT "compadre_auth_login_grants_user_id_compadre_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "compadre_users"("id") ON DELETE CASCADE;