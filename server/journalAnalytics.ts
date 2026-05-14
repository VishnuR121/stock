import type { JournalAnalytics, JournalExitReason, JournalTradeHighlight, TradeJournalEntry } from "../src/shared/types";
import { round } from "./indicators";

export function buildJournalAnalytics(journal: TradeJournalEntry[]): JournalAnalytics {
  const paperTrades = journal.filter((entry) => entry.status === "paper_open" || entry.status === "paper_closed");
  const closed = paperTrades.filter((entry) => entry.status === "paper_closed");
  const skipped = journal.filter((entry) => entry.status === "skipped");
  const followedPlanTrades = paperTrades.filter((entry) => entry.followedPlan === true).length;
  const planDeviationTrades = paperTrades.filter((entry) => entry.followedPlan === false).length;
  const planTaggedTrades = followedPlanTrades + planDeviationTrades;
  const highlights = closed
    .filter((entry) => typeof entry.pnl === "number" && Number.isFinite(entry.pnl))
    .map((entry) => toHighlight(entry))
    .sort((left, right) => right.pnl - left.pnl);
  const rMultiples = highlights
    .map((highlight) => highlight.rMultiple)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const wins = closed.filter((entry) => (entry.pnl ?? 0) > 0 || entry.outcome === "win").length;

  return {
    totalPaperTrades: paperTrades.length,
    openPaperTrades: paperTrades.filter((entry) => entry.status === "paper_open").length,
    closedPaperTrades: closed.length,
    skippedTrades: skipped.length,
    winRate: closed.length ? round((wins / closed.length) * 100, 2) : 0,
    averageR: rMultiples.length ? round(rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length, 2) : null,
    totalPnl: round(highlights.reduce((sum, trade) => sum + trade.pnl, 0), 2),
    followedPlanTrades,
    planDeviationTrades,
    followPlanRate: planTaggedTrades ? round((followedPlanTrades / planTaggedTrades) * 100, 2) : null,
    bestTrade: highlights[0] ?? null,
    worstTrade: highlights.at(-1) ?? null,
    mostCommonSkippedReason: getMostCommonSkippedReason(skipped),
    mostCommonExitReason: getMostCommonExitReason(closed)
  };
}

function toHighlight(entry: TradeJournalEntry): JournalTradeHighlight {
  return {
    id: entry.id,
    symbol: entry.symbol,
    pnl: round(entry.pnl ?? 0, 2),
    rMultiple: getRMultiple(entry)
  };
}

function getRMultiple(entry: TradeJournalEntry): number | null {
  if (typeof entry.pnl !== "number" || !entry.entryPrice || !entry.stopLossPrice) return null;
  const riskPerShare = Math.abs(entry.entryPrice - entry.stopLossPrice);
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) return null;
  return round(entry.pnl / riskPerShare, 2);
}

function getMostCommonSkippedReason(skipped: TradeJournalEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const entry of skipped) {
    const reason = normalizeReason(entry.notes);
    if (!reason) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function getMostCommonExitReason(closed: TradeJournalEntry[]): JournalExitReason | null {
  const counts = new Map<JournalExitReason, number>();
  for (const entry of closed) {
    if (!entry.exitReason) continue;
    counts.set(entry.exitReason, (counts.get(entry.exitReason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function normalizeReason(notes: string): string | null {
  const normalized = notes.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
