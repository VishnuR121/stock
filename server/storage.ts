import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SavedTradePlan, StoredAppData, TradeJournalEntry, WatchlistItem } from "../src/shared/types";

const seedWatchlist = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"].map<WatchlistItem>((symbol) => ({
  symbol,
  tags: symbol.length === 3 ? ["ETF"] : ["Large cap"],
  createdAt: new Date().toISOString()
}));

const emptyData = (): StoredAppData => ({
  watchlist: seedWatchlist,
  tradeNotes: {},
  savedPlans: {},
  contextCache: {},
  journal: [],
  scanHistory: []
});

export class JsonStore {
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

  async getCachedContext(symbol: string, maxAgeMs: number) {
    const data = await this.read();
    const cached = data.contextCache[symbol];
    if (!cached) return null;
    const age = Date.now() - new Date(cached.generatedAt).getTime();
    return age <= maxAgeMs ? cached : null;
  }

  async saveContext(symbol: string, context: StoredAppData["contextCache"][string]) {
    const data = await this.read();
    data.contextCache[symbol] = context;
    await this.write(data);
    return context;
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

  async getJournal(): Promise<TradeJournalEntry[]> {
    const data = await this.read();
    return data.journal;
  }

  private async ensureParent(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }
}

function normalizeData(raw: Partial<StoredAppData>): StoredAppData {
  return {
    watchlist: Array.isArray(raw.watchlist) ? raw.watchlist : seedWatchlist,
    tradeNotes: raw.tradeNotes ?? {},
    savedPlans: raw.savedPlans ?? {},
    contextCache: raw.contextCache ?? {},
    journal: Array.isArray(raw.journal) ? raw.journal : [],
    scanHistory: Array.isArray(raw.scanHistory) ? raw.scanHistory : []
  };
}
