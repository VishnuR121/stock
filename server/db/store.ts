import { desc, eq, inArray, sql } from "drizzle-orm";
import type { SavedTradePlan, StoredAppData, TradeContext, TradeJournalEntry, WatchlistItem } from "../../src/shared/types";
import type { AppDb } from "./client";
import {
  aiPlans,
  contextCache,
  journalEntries,
  scanRuns,
  signalSnapshots,
  tradeNotes,
  watchlistItems,
  watchlistRowToItem
} from "./schema";
import { createSeedWatchlist, normalizeData, type AppStore } from "../storage";

export class DatabaseStore implements AppStore {
  constructor(private readonly db: AppDb) {}

  async read(): Promise<StoredAppData> {
    const [watchlist, notes, savedPlans, journal, scans, contexts] = await Promise.all([
      this.getWatchlist(),
      this.getTradeNotes(),
      this.getSavedPlans(),
      this.getJournal(),
      this.getScanHistory(),
      this.getAllCachedContexts()
    ]);

    return {
      watchlist,
      tradeNotes: notes,
      savedPlans,
      contextCache: contexts,
      journal,
      scanHistory: scans
    };
  }

  async write(data: StoredAppData): Promise<void> {
    const normalized = normalizeData(data);
    await this.setWatchlist(normalized.watchlist);

    for (const [symbol, notes] of Object.entries(normalized.tradeNotes)) {
      await this.db
        .insert(tradeNotes)
        .values({ symbol, notes })
        .onConflictDoUpdate({
          target: tradeNotes.symbol,
          set: { notes, updatedAt: new Date() }
        });
    }

    for (const [symbol, context] of Object.entries(normalized.contextCache)) {
      await this.saveContext(symbol, context);
    }

    for (const plan of Object.values(normalized.savedPlans)) {
      await this.upsertSavedPlan(plan);
    }

    for (const entry of normalized.journal) {
      await this.upsertJournalEntry(entry);
    }

    for (const scan of normalized.scanHistory) {
      await this.upsertScanHistory(scan);
    }
  }

  async setWatchlist(watchlist: WatchlistItem[]): Promise<StoredAppData> {
    const normalized = watchlist.map((item) => ({
      ...item,
      symbol: item.symbol.trim().toUpperCase(),
      tags: item.tags.map((tag) => tag.trim()).filter(Boolean)
    }));

    await this.db.delete(watchlistItems);

    if (normalized.length) {
      await this.db
        .insert(watchlistItems)
        .values(
          normalized.map((item) => ({
            symbol: item.symbol,
            notes: item.notes,
            tags: item.tags,
            createdAt: new Date(item.createdAt)
          }))
        );
    }

    return this.read();
  }

  async addScanHistory(symbols: string[], snapshots: StoredAppData["scanHistory"][number]["snapshots"]) {
    const id = `scan-${Date.now()}`;
    const createdAt = new Date();
    await this.db.insert(scanRuns).values({ id, createdAt, symbols });

    if (snapshots.length) {
      await this.db.insert(signalSnapshots).values(
        snapshots.map((snapshot, index) => ({
          id: `${id}-${snapshot.symbol}-${index}`,
          scanId: id,
          symbol: snapshot.symbol,
          snapshot,
          createdAt
        }))
      );
    }

    return {
      id,
      createdAt: createdAt.toISOString(),
      symbols,
      snapshots
    };
  }

  async saveTradePlan(plan: Omit<SavedTradePlan, "id" | "createdAt">): Promise<SavedTradePlan> {
    const savedPlan: SavedTradePlan = {
      ...plan,
      id: `plan-${plan.symbol}-${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    await this.upsertSavedPlan(savedPlan);
    return savedPlan;
  }

  async getSavedPlans(): Promise<Record<string, SavedTradePlan>> {
    const rows = await this.db.select().from(aiPlans).orderBy(desc(aiPlans.createdAt));
    const plans: Record<string, SavedTradePlan> = {};

    for (const row of rows) {
      if (plans[row.symbol]) continue;
      plans[row.symbol] = {
        id: row.id,
        symbol: row.symbol,
        createdAt: row.createdAt.toISOString(),
        signalAsOf: row.signalAsOf.toISOString(),
        score: row.score,
        plan: row.plan,
        context: row.context
      };
    }

    return plans;
  }

  async getCachedContext(symbol: string, maxAgeMs: number): Promise<TradeContext | null> {
    const rows = await this.db.select().from(contextCache).where(eq(contextCache.symbol, symbol)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const age = Date.now() - row.generatedAt.getTime();
    return age <= maxAgeMs ? row.context : null;
  }

  async saveContext(symbol: string, context: TradeContext): Promise<TradeContext> {
    await this.db
      .insert(contextCache)
      .values({
        symbol,
        generatedAt: new Date(context.generatedAt),
        context,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: contextCache.symbol,
        set: {
          generatedAt: new Date(context.generatedAt),
          context,
          updatedAt: new Date()
        }
      });
    return context;
  }

  async addJournalEntry(entry: Omit<TradeJournalEntry, "id" | "createdAt" | "updatedAt">): Promise<TradeJournalEntry> {
    const now = new Date();
    const next: TradeJournalEntry = {
      ...entry,
      id: `journal-${entry.symbol}-${Date.now()}`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    await this.upsertJournalEntry(next);
    return next;
  }

  async getJournal(): Promise<TradeJournalEntry[]> {
    const rows = await this.db.select().from(journalEntries).orderBy(desc(journalEntries.createdAt)).limit(250);
    return rows.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      planId: row.planId ?? undefined,
      status: row.status,
      action: row.action,
      notes: row.notes,
      entryPrice: numberOrUndefined(row.entryPrice),
      exitPrice: numberOrUndefined(row.exitPrice),
      stopLossPrice: numberOrUndefined(row.stopLossPrice),
      takeProfitPrice: numberOrUndefined(row.takeProfitPrice),
      outcome: row.outcome ?? undefined,
      pnl: numberOrUndefined(row.pnl)
    }));
  }

  private async getWatchlist(): Promise<WatchlistItem[]> {
    const rows = await this.db.select().from(watchlistItems).orderBy(watchlistItems.createdAt);
    if (rows.length) return rows.map(watchlistRowToItem);

    const seed = createSeedWatchlist();
    await this.setWatchlist(seed);
    return seed;
  }

  private async getTradeNotes(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(tradeNotes);
    return Object.fromEntries(rows.map((row) => [row.symbol, row.notes]));
  }

  private async getAllCachedContexts(): Promise<Record<string, TradeContext>> {
    const rows = await this.db.select().from(contextCache);
    return Object.fromEntries(rows.map((row) => [row.symbol, row.context]));
  }

  private async getScanHistory(): Promise<StoredAppData["scanHistory"]> {
    const runs = await this.db.select().from(scanRuns).orderBy(desc(scanRuns.createdAt)).limit(25);
    if (!runs.length) return [];
    const ids = runs.map((run) => run.id);
    const snapshots = await this.db.select().from(signalSnapshots).where(inArray(signalSnapshots.scanId, ids));
    return runs.map((run) => ({
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      symbols: run.symbols,
      snapshots: snapshots.filter((snapshot) => snapshot.scanId === run.id).map((snapshot) => snapshot.snapshot)
    }));
  }

  private async upsertScanHistory(scan: StoredAppData["scanHistory"][number]): Promise<void> {
    await this.db
      .insert(scanRuns)
      .values({
        id: scan.id,
        createdAt: new Date(scan.createdAt),
        symbols: scan.symbols
      })
      .onConflictDoUpdate({
        target: scanRuns.id,
        set: {
          createdAt: new Date(scan.createdAt),
          symbols: scan.symbols
        }
      });

    if (!scan.snapshots.length) return;

    await this.db
      .insert(signalSnapshots)
      .values(
        scan.snapshots.map((snapshot, index) => ({
          id: `${scan.id}-${snapshot.symbol}-${index}`,
          scanId: scan.id,
          symbol: snapshot.symbol,
          snapshot,
          createdAt: new Date(scan.createdAt)
        }))
      )
      .onConflictDoUpdate({
        target: signalSnapshots.id,
        set: {
          snapshot: sql`excluded.snapshot`,
          symbol: sql`excluded.symbol`
        }
      });
  }

  private async upsertSavedPlan(plan: SavedTradePlan): Promise<void> {
    await this.db
      .insert(aiPlans)
      .values({
        id: plan.id,
        symbol: plan.symbol,
        createdAt: new Date(plan.createdAt),
        signalAsOf: new Date(plan.signalAsOf),
        score: plan.score,
        plan: plan.plan,
        context: plan.context
      })
      .onConflictDoUpdate({
        target: aiPlans.id,
        set: {
          score: plan.score,
          plan: plan.plan,
          context: plan.context
        }
      });
  }

  private async upsertJournalEntry(entry: TradeJournalEntry): Promise<void> {
    await this.db
      .insert(journalEntries)
      .values({
        id: entry.id,
        symbol: entry.symbol,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        planId: entry.planId,
        status: entry.status,
        action: entry.action,
        notes: entry.notes,
        entryPrice: valueOrNull(entry.entryPrice),
        exitPrice: valueOrNull(entry.exitPrice),
        stopLossPrice: valueOrNull(entry.stopLossPrice),
        takeProfitPrice: valueOrNull(entry.takeProfitPrice),
        outcome: entry.outcome ?? null,
        pnl: valueOrNull(entry.pnl)
      })
      .onConflictDoUpdate({
        target: journalEntries.id,
        set: {
          updatedAt: new Date(entry.updatedAt),
          status: entry.status,
          action: entry.action,
          notes: entry.notes,
          entryPrice: valueOrNull(entry.entryPrice),
          exitPrice: valueOrNull(entry.exitPrice),
          stopLossPrice: valueOrNull(entry.stopLossPrice),
          takeProfitPrice: valueOrNull(entry.takeProfitPrice),
          outcome: entry.outcome ?? null,
          pnl: valueOrNull(entry.pnl)
        }
      });
  }
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function valueOrNull(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
