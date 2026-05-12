import { sql } from "drizzle-orm";
import { integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type {
  AnalysisRun,
  OpportunityScan,
  RiskSettings,
  SignalSnapshot,
  TradeAction,
  TradeContext,
  TradeJournalEntry,
  TradingViewSignal,
  TradePlan,
  WatchlistItem
} from "../../src/shared/types";

export const watchlistItems = pgTable("watchlist_items", {
  symbol: text("symbol").primaryKey(),
  notes: text("notes"),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const tradeNotes = pgTable("trade_notes", {
  symbol: text("symbol").primaryKey(),
  notes: text("notes").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const scanRuns = pgTable("scan_runs", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  symbols: jsonb("symbols").$type<string[]>().notNull()
});

export const signalSnapshots = pgTable("signal_snapshots", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull().references(() => scanRuns.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  snapshot: jsonb("snapshot").$type<SignalSnapshot>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const contextCache = pgTable("context_cache", {
  symbol: text("symbol").primaryKey(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  context: jsonb("context").$type<TradeContext>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const aiPlans = pgTable("ai_plans", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  signalAsOf: timestamp("signal_as_of", { withTimezone: true }).notNull(),
  score: integer("score").notNull(),
  plan: jsonb("plan").$type<TradePlan>().notNull(),
  context: jsonb("context").$type<TradeContext>().notNull()
});

export const analysisRuns = pgTable("analysis_runs", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  signalAsOf: timestamp("signal_as_of", { withTimezone: true }).notNull(),
  run: jsonb("run").$type<AnalysisRun>().notNull()
});

export const tradingViewSignals = pgTable("tradingview_signals", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  symbol: text("symbol").notNull(),
  signal: jsonb("signal").$type<TradingViewSignal>().notNull()
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<RiskSettings | OpportunityScan | Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const journalEntries = pgTable("journal_entries", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  planId: text("plan_id"),
  status: text("status").$type<TradeJournalEntry["status"]>().notNull(),
  action: text("action").$type<TradeAction>().notNull(),
  notes: text("notes").notNull().default(""),
  entryPrice: numeric("entry_price"),
  exitPrice: numeric("exit_price"),
  stopLossPrice: numeric("stop_loss_price"),
  takeProfitPrice: numeric("take_profit_price"),
  outcome: text("outcome").$type<TradeJournalEntry["outcome"]>(),
  pnl: numeric("pnl")
});

export const apiCallLog = pgTable("api_call_log", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  endpoint: text("endpoint").notNull(),
  symbol: text("symbol"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`)
});

export function watchlistRowToItem(row: typeof watchlistItems.$inferSelect): WatchlistItem {
  return {
    symbol: row.symbol,
    notes: row.notes ?? undefined,
    tags: row.tags,
    createdAt: row.createdAt.toISOString()
  };
}
