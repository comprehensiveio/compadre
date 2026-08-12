CREATE TABLE "compadre_ai_interrupts" (
	"interrupt_id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" text NOT NULL,
	"requested_at_ms" bigint NOT NULL,
	"resolved_at_ms" bigint,
	"payload" jsonb NOT NULL,
	"response" jsonb,
	CONSTRAINT "compadre_ai_interrupts_status_check" CHECK ("status" in ('pending', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "compadre_ai_metadata" (
	"namespace" text,
	"key" text,
	"value" jsonb NOT NULL,
	CONSTRAINT "compadre_ai_metadata_pkey" PRIMARY KEY("namespace","key")
);
--> statement-breakpoint
CREATE TABLE "compadre_ai_threads" (
	"thread_id" text PRIMARY KEY,
	"messages" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "compadre_ai_interrupts_thread_requested_idx" ON "compadre_ai_interrupts" ("thread_id","requested_at_ms");--> statement-breakpoint
CREATE INDEX "compadre_ai_interrupts_run_requested_idx" ON "compadre_ai_interrupts" ("run_id","requested_at_ms");