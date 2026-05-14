ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "signal_as_of" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "source_type" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "source_id" text;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "followed_plan" boolean;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "exit_reason" text;
