import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AlgoTradeProposal,
  AnalysisRun,
  OptionIdea,
  OpportunityScan,
  RiskSettings,
  SavedTradePlan,
  StoredAppData,
  TradeContext,
  TradeJournalEntry,
  TradingViewSignal,
  WatchlistItem
} from "../src/shared/types";

export interface AppStore {
  read(): Promise<StoredAppData>;
  write(data: StoredAppData): Promise<void>;
  getWatchlist(): Promise<WatchlistItem[]>;
  setWatchlist(watchlist: WatchlistItem[]): Promise<StoredAppData>;
  addScanHistory(
    symbols: string[],
    snapshots: StoredAppData["scanHistory"][number]["snapshots"]
  ): Promise<StoredAppData["scanHistory"][number]>;
  saveTradePlan(plan: Omit<SavedTradePlan, "id" | "createdAt">): Promise<SavedTradePlan>;
  getSavedPlans(): Promise<Record<string, SavedTradePlan>>;
  saveAnalysisRun(run: AnalysisRun): Promise<AnalysisRun>;
  getAnalysisRuns(symbol: string, limit?: number): Promise<AnalysisRun[]>;
  saveTradingViewSignal(signal: TradingViewSignal): Promise<TradingViewSignal>;
  getTradingViewSignals(limit?: number): Promise<TradingViewSignal[]>;
  getRiskSettings(): Promise<RiskSettings>;
  saveRiskSettings(settings: RiskSettings): Promise<RiskSettings>;
  getCachedContext(symbol: string, maxAgeMs: number): Promise<TradeContext | null>;
  saveContext(symbol: string, context: TradeContext): Promise<TradeContext>;
  getCachedSignal(symbol: string, maxAgeMs: number): Promise<AnalysisRun["snapshot"] | null>;
  saveSignalSnapshot(signal: AnalysisRun["snapshot"]): Promise<AnalysisRun["snapshot"]>;
  getCachedOptionIdeas(symbol: string, maxAgeMs: number): Promise<OptionIdea[] | null>;
  saveOptionIdeas(symbol: string, ideas: OptionIdea[]): Promise<OptionIdea[]>;
  getLatestOpportunityScan(): Promise<OpportunityScan | null>;
  saveOpportunityScan(scan: OpportunityScan): Promise<OpportunityScan>;
  getAlgoTradeProposals(limit?: number): Promise<AlgoTradeProposal[]>;
  saveAlgoTradeProposals(proposals: AlgoTradeProposal[]): Promise<AlgoTradeProposal[]>;
  updateAlgoTradeProposal(id: string, patch: Partial<AlgoTradeProposal>): Promise<AlgoTradeProposal>;
  deleteAlgoTradeProposal(id: string): Promise<{ id: string }>;
  addJournalEntry(entry: Omit<TradeJournalEntry, "id" | "createdAt" | "updatedAt">): Promise<TradeJournalEntry>;
  updateJournalEntry(id: string, patch: Partial<Omit<TradeJournalEntry, "id" | "createdAt">>): Promise<TradeJournalEntry>;
  getJournal(): Promise<TradeJournalEntry[]>;
  deleteJournalEntry(id: string): Promise<{ id: string }>;
}

export const createSeedWatchlist = () =>
  ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"].map<WatchlistItem>((symbol) => ({
    symbol,
    tags: symbol.length === 3 ? ["ETF"] : ["Large cap"],
    createdAt: new Date().toISOString()
  }));

const emptyData = (): StoredAppData => ({
  watchlist: createSeedWatchlist(),
  tradeNotes: {},
  savedPlans: {},
  analysisRuns: {},
  tradingViewSignals: [],
  riskSettings: getDefaultRiskSettings(),
  contextCache: {},
  signalCache: {},
  optionsCache: {},
  journal: [],
  algoTradeProposals: [],
  opportunityScans: [],
  scanHistory: []
});

export function getDefaultRiskSettings(): RiskSettings {
  return {
    maxRiskPerTradePct: 0.01,
    maxPositionPct: 0.1,
    maxDailyLossPct: 0.03,
    minRiskReward: 1.5,
    maxDataAgeMinutes: 60 * 24 * 3,
    priceCollarPct: 0.03,
    earningsWindowDays: 7,
    killSwitchEnabled: false,
    maxOpenPositions: 12,
    maxOptionsContracts: 4,
    maxStrategyExposurePct: 0.1,
    allowZeroDte: false
  };
}

export class JsonStore implements AppStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<StoredAppData> {
    await this.ensureParent();

    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeData(JSON.parse(raw) as Partial<StoredAppData>);
    } catch (error) {
      const data = emptyData();
      await this.write(data);
      return data;
    }
  }

  async write(data: StoredAppData): Promise<void> {
    await this.ensureParent();
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    const data = await this.read();
    return data.watchlist;
  }

  async setWatchlist(watchlist: WatchlistItem[]): Promise<StoredAppData> {
    const data = await this.read();
    const normalized = watchlist.map((item) => ({
      ...item,
      symbol: item.symbol.trim().toUpperCase(),
      tags: item.tags.map((tag) => tag.trim()).filter(Boolean)
    }));
    data.watchlist = normalized;
    await this.write(data);
    return data;
  }

  async addScanHistory(symbols: string[], snapshots: StoredAppData["scanHistory"][number]["snapshots"]) {
    const data = await this.read();
    data.scanHistory.unshift({
      id: `scan-${Date.now()}`,
      createdAt: new Date().toISOString(),
      symbols,
      snapshots
    });
    data.scanHistory = data.scanHistory.slice(0, 25);
    await this.write(data);
    return data.scanHistory[0];
  }

  async saveTradePlan(plan: Omit<SavedTradePlan, "id" | "createdAt">): Promise<SavedTradePlan> {
    const data = await this.read();
    const savedPlan: SavedTradePlan = {
      ...plan,
      id: `plan-${plan.symbol}-${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    data.savedPlans[plan.symbol] = savedPlan;
    await this.write(data);
    return savedPlan;
  }

  async getSavedPlans(): Promise<Record<string, SavedTradePlan>> {
    const data = await this.read();
    return data.savedPlans;
  }

  async saveAnalysisRun(run: AnalysisRun): Promise<AnalysisRun> {
    const data = await this.read();
    data.analysisRuns[run.symbol] = [run, ...(data.analysisRuns[run.symbol] ?? [])].slice(0, 25);
    await this.write(data);
    return run;
  }

  async getAnalysisRuns(symbol: string, limit = 10): Promise<AnalysisRun[]> {
    const data = await this.read();
    return (data.analysisRuns[symbol] ?? []).slice(0, limit);
  }

  async saveTradingViewSignal(signal: TradingViewSignal): Promise<TradingViewSignal> {
    const data = await this.read();
    data.tradingViewSignals.unshift(signal);
    data.tradingViewSignals = data.tradingViewSignals.slice(0, 100);
    await this.write(data);
    return signal;
  }

  async getTradingViewSignals(limit = 25): Promise<TradingViewSignal[]> {
    const data = await this.read();
    return data.tradingViewSignals.slice(0, limit);
  }

  async getRiskSettings(): Promise<RiskSettings> {
    const data = await this.read();
    return data.riskSettings;
  }

  async saveRiskSettings(settings: RiskSettings): Promise<RiskSettings> {
    const data = await this.read();
    data.riskSettings = settings;
    await this.write(data);
    return settings;
  }

  async getCachedContext(symbol: string, maxAgeMs: number): Promise<TradeContext | null> {
    const data = await this.read();
    const cached = data.contextCache[symbol];
    if (!cached) return null;
    const age = Date.now() - new Date(cached.generatedAt).getTime();
    return age <= maxAgeMs ? cached : null;
  }

  async saveContext(symbol: string, context: TradeContext): Promise<TradeContext> {
    const data = await this.read();
    data.contextCache[symbol] = context;
    await this.write(data);
    return context;
  }

  async getCachedSignal(symbol: string, maxAgeMs: number): Promise<AnalysisRun["snapshot"] | null> {
    const data = await this.read();
    const cached = data.signalCache[symbol];
    if (!cached) return null;
    const age = Date.now() - new Date(cached.savedAt).getTime();
    return age <= maxAgeMs ? cached.signal : null;
  }

  async saveSignalSnapshot(signal: AnalysisRun["snapshot"]): Promise<AnalysisRun["snapshot"]> {
    const data = await this.read();
    data.signalCache[signal.symbol] = {
      savedAt: new Date().toISOString(),
      signal
    };
    await this.write(data);
    return signal;
  }

  async getCachedOptionIdeas(symbol: string, maxAgeMs: number): Promise<OptionIdea[] | null> {
    const data = await this.read();
    const cached = data.optionsCache[symbol];
    if (!cached) return null;
    const age = Date.now() - new Date(cached.savedAt).getTime();
    return age <= maxAgeMs ? cached.ideas : null;
  }

  async saveOptionIdeas(symbol: string, ideas: OptionIdea[]): Promise<OptionIdea[]> {
    const data = await this.read();
    data.optionsCache[symbol] = {
      savedAt: new Date().toISOString(),
      ideas
    };
    await this.write(data);
    return ideas;
  }

  async getLatestOpportunityScan(): Promise<OpportunityScan | null> {
    const data = await this.read();
    return data.opportunityScans[0] ?? null;
  }

  async saveOpportunityScan(scan: OpportunityScan): Promise<OpportunityScan> {
    const data = await this.read();
    data.opportunityScans = [scan, ...data.opportunityScans.filter((item) => item.id !== scan.id)].slice(0, 10);
    await this.write(data);
    return scan;
  }

  async getAlgoTradeProposals(limit = 50): Promise<AlgoTradeProposal[]> {
    const data = await this.read();
    return data.algoTradeProposals.slice(0, limit);
  }

  async saveAlgoTradeProposals(proposals: AlgoTradeProposal[]): Promise<AlgoTradeProposal[]> {
    const data = await this.read();
    const keys = new Set(proposals.map(getActiveProposalKey));
    data.algoTradeProposals = [
      ...proposals,
      ...data.algoTradeProposals.filter((proposal) => !keys.has(getActiveProposalKey(proposal)))
    ].slice(0, 100);
    await this.write(data);
    return proposals;
  }

  async updateAlgoTradeProposal(id: string, patch: Partial<AlgoTradeProposal>): Promise<AlgoTradeProposal> {
    const data = await this.read();
    const index = data.algoTradeProposals.findIndex((proposal) => proposal.id === id);
    if (index === -1) throw new Error("Algo trade proposal not found.");
    const next: AlgoTradeProposal = {
      ...data.algoTradeProposals[index],
      ...patch,
      id,
      updatedAt: new Date().toISOString()
    };
    data.algoTradeProposals[index] = next;
    await this.write(data);
    return next;
  }

  async deleteAlgoTradeProposal(id: string): Promise<{ id: string }> {
    const data = await this.read();
    data.algoTradeProposals = data.algoTradeProposals.filter((proposal) => proposal.id !== id);
    await this.write(data);
    return { id };
  }

  async addJournalEntry(entry: Omit<TradeJournalEntry, "id" | "createdAt" | "updatedAt">): Promise<TradeJournalEntry> {
    const data = await this.read();
    const now = new Date().toISOString();
    const next: TradeJournalEntry = {
      ...entry,
      id: `journal-${entry.symbol}-${Date.now()}`,
      createdAt: now,
      updatedAt: now
    };
    data.journal.unshift(next);
    data.journal = data.journal.slice(0, 250);
    await this.write(data);
    return next;
  }

  async updateJournalEntry(id: string, patch: Partial<Omit<TradeJournalEntry, "id" | "createdAt">>): Promise<TradeJournalEntry> {
    const data = await this.read();
    const index = data.journal.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error("Journal entry not found.");
    const next: TradeJournalEntry = {
      ...data.journal[index],
      ...patch,
      id,
      createdAt: data.journal[index].createdAt,
      updatedAt: new Date().toISOString()
    };
    data.journal[index] = next;
    await this.write(data);
    return next;
  }

  async getJournal(): Promise<TradeJournalEntry[]> {
    const data = await this.read();
    return data.journal;
  }

  async deleteJournalEntry(id: string): Promise<{ id: string }> {
    const data = await this.read();
    data.journal = data.journal.filter((entry) => entry.id !== id);
    await this.write(data);
    return { id };
  }

  private async ensureParent(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }
}

export class MemoryStore extends JsonStore {
  private data: StoredAppData;

  constructor(seed: Partial<StoredAppData> = {}) {
    super("__memory__");
    this.data = normalizeData(seed);
  }

  async read(): Promise<StoredAppData> {
    return cloneData(this.data);
  }

  async write(data: StoredAppData): Promise<void> {
    this.data = cloneData(normalizeData(data));
  }
}

export function normalizeData(raw: Partial<StoredAppData>): StoredAppData {
  return {
    watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : createSeedWatchlist(),
    tradeNotes: raw.tradeNotes ?? {},
    savedPlans: raw.savedPlans ?? {},
    analysisRuns: raw.analysisRuns ?? {},
    tradingViewSignals: Array.isArray(raw.tradingViewSignals) ? raw.tradingViewSignals : [],
    riskSettings: { ...getDefaultRiskSettings(), ...(raw.riskSettings ?? {}) },
    contextCache: raw.contextCache ?? {},
    signalCache: raw.signalCache ?? {},
    optionsCache: raw.optionsCache ?? {},
    journal: Array.isArray(raw.journal) ? raw.journal : [],
    algoTradeProposals: Array.isArray(raw.algoTradeProposals) ? raw.algoTradeProposals : [],
    opportunityScans: Array.isArray(raw.opportunityScans) ? raw.opportunityScans : [],
    scanHistory: Array.isArray(raw.scanHistory) ? raw.scanHistory : []
  };
}

function cloneData(data: StoredAppData): StoredAppData {
  return JSON.parse(JSON.stringify(data)) as StoredAppData;
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
