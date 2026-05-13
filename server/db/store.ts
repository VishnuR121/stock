import { desc, eq, inArray, sql } from "drizzle-orm";
import type {
  AlgoTradeProposal,
  AnalysisRun,
  CachedOptionIdeas,
  CachedSignalSnapshot,
  OptionIdea,
  OpportunityScan,
  RiskSettings,
  SavedTradePlan,
  StoredAppData,
  TradeContext,
  TradeJournalEntry,
  TradingViewSignal,
  WatchlistItem
} from "../../src/shared/types";
import type { AppDb } from "./client";
import {
  aiPlans,
  analysisRuns,
  appSettings,
  contextCache,
  journalEntries,
  scanRuns,
  signalSnapshots,
  tradeNotes,
  tradingViewSignals,
  watchlistItems,
  watchlistRowToItem
} from "./schema";
import { createSeedWatchlist, getDefaultRiskSettings, normalizeData, type AppStore } from "../storage";

export class DatabaseStore implements AppStore {
  constructor(private readonly db: AppDb) {}

  async read(): Promise<StoredAppData> {
    const [watchlist, notes, savedPlans, journal, algoTradeProposals, scans, contexts, settings, signals, opportunityScan, signalCache, optionsCache] = await Promise.all([
      this.getWatchlist(),
      this.getTradeNotes(),
      this.getSavedPlans(),
      this.getJournal(),
      this.getAlgoTradeProposals(),
      this.getScanHistory(),
      this.getAllCachedContexts(),
      this.getRiskSettings(),
      this.getTradingViewSignals(),
      this.getLatestOpportunityScan(),
      this.getSignalCacheMap(),
      this.getOptionsCacheMap()
    ]);

    return {
      watchlist,
      tradeNotes: notes,
      savedPlans,
      analysisRuns: {},
      tradingViewSignals: signals,
      riskSettings: settings,
      contextCache: contexts,
      signalCache,
      optionsCache,
      journal,
      algoTradeProposals,
      opportunityScans: opportunityScan ? [opportunityScan] : [],
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

    for (const entry of Object.values(normalized.signalCache)) {
      await this.saveSignalSnapshot(entry.signal);
    }

    for (const [symbol, entry] of Object.entries(normalized.optionsCache)) {
      await this.saveOptionIdeas(symbol, entry.ideas);
    }

    for (const plan of Object.values(normalized.savedPlans)) {
      await this.upsertSavedPlan(plan);
    }

    for (const runs of Object.values(normalized.analysisRuns)) {
      for (const run of runs) {
        await this.saveAnalysisRun(run);
      }
    }

    for (const signal of normalized.tradingViewSignals) {
      await this.saveTradingViewSignal(signal);
    }

    await this.saveRiskSettings(normalized.riskSettings);

    for (const entry of normalized.journal) {
      await this.upsertJournalEntry(entry);
    }

    if (normalized.algoTradeProposals.length) {
      await this.saveAlgoTradeProposals(normalized.algoTradeProposals);
    }

    if (normalized.opportunityScans[0]) {
      await this.saveOpportunityScan(normalized.opportunityScans[0]);
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

    return {
      watchlist: normalized,
      tradeNotes: {},
      savedPlans: {},
      analysisRuns: {},
      tradingViewSignals: [],
      riskSettings: await this.getRiskSettings(),
      contextCache: {},
      signalCache: {},
      optionsCache: {},
      journal: [],
      algoTradeProposals: [],
      opportunityScans: [],
      scanHistory: []
    };
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

  async saveAnalysisRun(run: AnalysisRun): Promise<AnalysisRun> {
    await this.db
      .insert(analysisRuns)
      .values({
        id: run.id,
        symbol: run.symbol,
        createdAt: new Date(run.createdAt),
        signalAsOf: new Date(run.signalAsOf),
        run
      })
      .onConflictDoUpdate({
        target: analysisRuns.id,
        set: {
          run,
          signalAsOf: new Date(run.signalAsOf)
        }
      });
    return run;
  }

  async getAnalysisRuns(symbol: string, limit = 10): Promise<AnalysisRun[]> {
    const rows = await this.db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.symbol, symbol))
      .orderBy(desc(analysisRuns.createdAt))
      .limit(limit);
    return rows.map((row) => row.run);
  }

  async saveTradingViewSignal(signal: TradingViewSignal): Promise<TradingViewSignal> {
    await this.db
      .insert(tradingViewSignals)
      .values({
        id: signal.id,
        createdAt: new Date(signal.createdAt),
        symbol: signal.symbol,
        signal
      })
      .onConflictDoUpdate({
        target: tradingViewSignals.id,
        set: { signal }
      });
    return signal;
  }

  async getTradingViewSignals(limit = 25): Promise<TradingViewSignal[]> {
    const rows = await this.db.select().from(tradingViewSignals).orderBy(desc(tradingViewSignals.createdAt)).limit(limit);
    return rows.map((row) => row.signal);
  }

  async getRiskSettings(): Promise<RiskSettings> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, "risk")).limit(1);
    return { ...getDefaultRiskSettings(), ...((rows[0]?.value as Partial<RiskSettings> | undefined) ?? {}) };
  }

  async saveRiskSettings(settings: RiskSettings): Promise<RiskSettings> {
    await this.db
      .insert(appSettings)
      .values({ key: "risk", value: settings, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: settings, updatedAt: new Date() }
      });
    return settings;
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

  async getCachedSignal(symbol: string, maxAgeMs: number): Promise<AnalysisRun["snapshot"] | null> {
    const cache = await this.getSignalCacheMap();
    const cached = cache[symbol];
    if (!cached) return null;
    const age = Date.now() - new Date(cached.savedAt).getTime();
    return age <= maxAgeMs ? cached.signal : null;
  }

  async saveSignalSnapshot(signal: AnalysisRun["snapshot"]): Promise<AnalysisRun["snapshot"]> {
    const cache = await this.getSignalCacheMap();
    cache[signal.symbol] = {
      savedAt: new Date().toISOString(),
      signal
    };
    await this.saveAppSetting("signalCache", cache);
    return signal;
  }

  async getCachedOptionIdeas(symbol: string, maxAgeMs: number): Promise<OptionIdea[] | null> {
    const cache = await this.getOptionsCacheMap();
    const cached = cache[symbol];
    if (!cached) return null;
    const age = Date.now() - new Date(cached.savedAt).getTime();
    return age <= maxAgeMs ? cached.ideas : null;
  }

  async saveOptionIdeas(symbol: string, ideas: OptionIdea[]): Promise<OptionIdea[]> {
    const cache = await this.getOptionsCacheMap();
    cache[symbol] = {
      savedAt: new Date().toISOString(),
      ideas
    };
    await this.saveAppSetting("optionsCache", cache);
    return ideas;
  }

  async getLatestOpportunityScan(): Promise<OpportunityScan | null> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, "latestOpportunityScan")).limit(1);
    return (rows[0]?.value as OpportunityScan | undefined) ?? null;
  }

  async saveOpportunityScan(scan: OpportunityScan): Promise<OpportunityScan> {
    await this.db
      .insert(appSettings)
      .values({ key: "latestOpportunityScan", value: scan, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: scan, updatedAt: new Date() }
      });
    return scan;
  }

  async getAlgoTradeProposals(limit = 50): Promise<AlgoTradeProposal[]> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, "algoTradeProposals")).limit(1);
    const proposals = (rows[0]?.value as AlgoTradeProposal[] | undefined) ?? [];
    return proposals.slice(0, limit);
  }

  async saveAlgoTradeProposals(proposals: AlgoTradeProposal[]): Promise<AlgoTradeProposal[]> {
    const current = await this.getAlgoTradeProposals(100);
    const keys = new Set(proposals.map(getActiveProposalKey));
    const next = [...proposals, ...current.filter((proposal) => !keys.has(getActiveProposalKey(proposal)))].slice(0, 100);
    await this.db
      .insert(appSettings)
      .values({ key: "algoTradeProposals", value: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: next, updatedAt: new Date() }
      });
    return proposals;
  }

  async updateAlgoTradeProposal(id: string, patch: Partial<AlgoTradeProposal>): Promise<AlgoTradeProposal> {
    const current = await this.getAlgoTradeProposals(100);
    const index = current.findIndex((proposal) => proposal.id === id);
    if (index === -1) throw new Error("Algo trade proposal not found.");
    const nextProposal: AlgoTradeProposal = {
      ...current[index],
      ...patch,
      id,
      updatedAt: new Date().toISOString()
    };
    current[index] = nextProposal;
    await this.db
      .insert(appSettings)
      .values({ key: "algoTradeProposals", value: current, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: current, updatedAt: new Date() }
      });
    return nextProposal;
  }

  async deleteAlgoTradeProposal(id: string): Promise<{ id: string }> {
    const current = (await this.getAlgoTradeProposals(100)).filter((proposal) => proposal.id !== id);
    await this.db
      .insert(appSettings)
      .values({ key: "algoTradeProposals", value: current, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: current, updatedAt: new Date() }
      });
    return { id };
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

  async deleteJournalEntry(id: string): Promise<{ id: string }> {
    await this.db.delete(journalEntries).where(eq(journalEntries.id, id));
    return { id };
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    const rows = await this.db.select().from(watchlistItems).orderBy(watchlistItems.createdAt);
    if (rows.length) return rows.map(watchlistRowToItem);

    const seed = createSeedWatchlist();
    await this.db.insert(watchlistItems).values(
      seed.map((item) => ({
        symbol: item.symbol,
        notes: item.notes,
        tags: item.tags,
        createdAt: new Date(item.createdAt)
      }))
    );
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

  private async getSignalCacheMap(): Promise<Record<string, CachedSignalSnapshot>> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, "signalCache")).limit(1);
    return (rows[0]?.value as Record<string, CachedSignalSnapshot> | undefined) ?? {};
  }

  private async getOptionsCacheMap(): Promise<Record<string, CachedOptionIdeas>> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, "optionsCache")).limit(1);
    return (rows[0]?.value as Record<string, CachedOptionIdeas> | undefined) ?? {};
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

  private async saveAppSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(appSettings)
      .values({ key, value: value as Record<string, unknown>, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: value as Record<string, unknown>, updatedAt: new Date() }
      });
  }
}

function getActiveProposalKey(proposal: AlgoTradeProposal): string {
  if (proposal.status === "placed" || proposal.status === "rejected") return proposal.id;
  return [
    proposal.symbol,
    proposal.strategyKind,
    proposal.direction,
    proposal.executionType,
    proposal.order?.side ?? "",
    proposal.optionOrder?.contractSymbol ?? ""
  ].join("|");
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function valueOrNull(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
