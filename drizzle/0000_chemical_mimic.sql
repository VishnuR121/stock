CREATE TABLE "ai_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signal_as_of" timestamp with time zone NOT NULL,
	"score" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"context" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_call_log" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"symbol" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_cache" (
	"symbol" text PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"context" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" text,
	"status" text NOT NULL,
	"action" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"entry_price" numeric,
	"exit_price" numeric,
	"stop_loss_price" numeric,
	"take_profit_price" numeric,
	"outcome" text,
	"pnl" numeric
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"symbols" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"symbol" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_notes" (
	"symbol" text PRIMARY KEY NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"symbol" text PRIMARY KEY NOT NULL,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_snapshots" ADD CONSTRAINT "signal_snapshots_scan_id_scan_runs_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;