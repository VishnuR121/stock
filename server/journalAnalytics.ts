import type { JournalAnalytics, JournalExitReason, JournalExpressionStat, JournalTradeHighlight, TradeJournalEntry } from "../src/shared/types";
import { round } from "./indicators";

export function buildJournalAnalytics(journal: TradeJournalEntry[]): JournalAnalytics {
  const paperTrades = journal.filter((entry) => entry.status === "paper_open" || entry.status === "paper_closed");
  const closed = paperTrades.filter((entry) => entry.status === "paper_closed");
  const skipped = journal.filter((entry) => entry.status === "skipped");
  const followedPlanTrades = paperTrades.filter((entry) => entry.followedPlan === true).length;
  const planDeviationTrades = paperTrades.filter((entry) => entry.followedPlan === false).length;
  const planTaggedTrades = followedPlanTrades + planDeviationTrades;
  const highlights = closed
    .filter((entry) => typeof getPnl(entry) === "number" && Number.isFinite(getPnl(entry)))
    .map((entry) => toHighlight(entry))
    .sort((left, right) => right.pnl - left.pnl);
  const rMultiples = highlights
    .map((highlight) => highlight.rMultiple)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const wins = closed.filter((entry) => (getPnl(entry) ?? 0) > 0 || entry.outcome === "win").length;
  const performanceByExpressionType = buildStats(paperTrades, (entry) => entry.expressionType ?? legacyExpressionType(entry));

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
    mostCommonExitReason: getMostCommonExitReason(closed),
    performanceByExpressionType,
    performanceByUnderlying: buildStats(paperTrades, (entry) => entry.underlyingSymbol ?? entry.symbol),
    performanceByMarketRegime: buildStats(paperTrades, (entry) => entry.entryMarketRegime ?? "unknown"),
    performanceByAiConfidence: buildStats(paperTrades, (entry) => entry.aiConfidence ?? "unknown"),
    winRateByExpressionType: performanceByExpressionType,
    averageRByExpressionType: performanceByExpressionType,
    optionsMetrics: buildOptionsMetrics(paperTrades)
  };
}

function toHighlight(entry: TradeJournalEntry): JournalTradeHighlight {
  return {
    id: entry.id,
    symbol: entry.symbol,
    pnl: round(getPnl(entry) ?? 0, 2),
    rMultiple: getRMultiple(entry)
  };
}

function getRMultiple(entry: TradeJournalEntry): number | null {
  if (typeof entry.actualRMultiple === "number" && Number.isFinite(entry.actualRMultiple)) return round(entry.actualRMultiple, 2);
  if (typeof getPnl(entry) !== "number" || !entry.entryPrice || !entry.stopLossPrice) return null;
  const riskPerShare = Math.abs(entry.entryPrice - entry.stopLossPrice);
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) return null;
  return round((getPnl(entry) ?? 0) / riskPerShare, 2);
}

function buildStats(entries: TradeJournalEntry[], getKey: (entry: TradeJournalEntry) => string | undefined): JournalExpressionStat[] {
  const groups = new Map<string, TradeJournalEntry[]>();
  for (const entry of entries) {
    const key = getKey(entry);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const closed = group.filter((entry) => entry.status === "paper_closed");
      const closedWithPnl = closed.filter((entry) => typeof getPnl(entry) === "number");
      const wins = closed.filter((entry) => (getPnl(entry) ?? 0) > 0 || entry.outcome === "win").length;
      const rMultiples = closed
        .map((entry) => getRMultiple(entry))
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      return {
        key,
        trades: group.length,
        closedTrades: closed.length,
        winRate: closed.length ? round((wins / closed.length) * 100, 2) : 0,
        averageR: rMultiples.length ? round(rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length, 2) : null,
        totalPnl: round(closedWithPnl.reduce((sum, entry) => sum + (getPnl(entry) ?? 0), 0), 2)
      };
    })
    .sort((left, right) => right.trades - left.trades || left.key.localeCompare(right.key));
}

function buildOptionsMetrics(entries: TradeJournalEntry[]): JournalAnalytics["optionsMetrics"] {
  const optionsEntries = entries.filter((entry) => (entry.optionLegs?.length ?? 0) > 0 || entry.assetClass === "option" || entry.assetClass === "multi_leg_option");
  const dtes = optionsEntries
    .map(getAverageEntryDte)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    averageDteAtEntry: dtes.length ? round(dtes.reduce((sum, value) => sum + value, 0) / dtes.length, 2) : null,
    performanceByDteBucket: buildStats(optionsEntries, (entry) => getDteBucket(getAverageEntryDte(entry))),
    performanceByOptionType: buildStats(optionsEntries, getOptionTypeKey),
    performanceByStructure: buildStats(optionsEntries, (entry) => (entry.optionLegs?.length ?? 0) > 1 ? "spread" : "single_leg"),
    assignmentRiskEvents: optionsEntries.filter((entry) => entry.optionLegs?.some((leg) => leg.side === "sell")).length
  };
}

function getPnl(entry: TradeJournalEntry): number | undefined {
  return typeof entry.realizedPnL === "number" ? entry.realizedPnL : entry.pnl;
}

function getAverageEntryDte(entry: TradeJournalEntry): number | null {
  if (!entry.optionLegs?.length) return null;
  const entryTime = new Date(entry.createdAt).getTime();
  if (!Number.isFinite(entryTime)) return null;
  const dtes = entry.optionLegs
    .map((leg) => Math.ceil((new Date(`${leg.expiration}T21:00:00.000Z`).getTime() - entryTime) / 86400000))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return dtes.length ? round(dtes.reduce((sum, value) => sum + value, 0) / dtes.length, 2) : null;
}

function getDteBucket(dte: number | null): string {
  if (dte === null) return "unknown";
  if (dte <= 7) return "0-7 DTE";
  if (dte <= 21) return "8-21 DTE";
  if (dte <= 45) return "22-45 DTE";
  if (dte <= 60) return "46-60 DTE";
  return "61+ DTE";
}

function getOptionTypeKey(entry: TradeJournalEntry): string {
  const types = [...new Set((entry.optionLegs ?? []).map((leg) => leg.optionType))];
  if (!types.length) return "unknown";
  return types.length === 1 ? types[0] : "mixed";
}

function legacyExpressionType(entry: TradeJournalEntry): string {
  if (entry.action === "paper_short_candidate") return "short_equity";
  if (entry.action === "paper_long_candidate") return "long_equity";
  if (entry.action === "paper_options_candidate" || entry.action === "options_research_only") return "option";
  return "unknown";
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
