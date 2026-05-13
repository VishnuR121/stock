import type {
  Bar,
  MarketRegimeSnapshot,
  OpportunityCandidate,
  OpportunityCategory,
  OpportunityScan,
  RiskProfile,
  RiskSettings,
  SignalSnapshot
} from "../src/shared/types";
import { buildSignalSnapshot, round } from "./indicators";
import { rankSignalSnapshot } from "./ranking";

export const DEFAULT_OPPORTUNITY_UNIVERSE = [
  "SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU",
  "AAPL", "MSFT", "NVDA", "AMD", "TSLA", "META", "GOOGL", "AMZN", "NFLX", "AVGO", "CRM",
  "ORCL", "INTC", "MU", "SMCI", "PLTR", "JPM", "BAC", "GS", "MS", "V", "MA", "PYPL",
  "COIN", "HOOD", "XOM", "CVX", "OXY", "UNH", "LLY", "NVO", "JNJ", "PFE", "MRK", "COST",
  "WMT", "TGT", "HD", "MCD", "NKE", "BA", "CAT", "GE", "DIS", "UBER", "ABNB", "RIVN", "F", "GM"
] as const;

interface BuildOpportunityScanInput {
  riskProfile: RiskProfile;
  riskSettings: RiskSettings;
  getBars: (symbol: string) => Promise<Bar[]>;
  universe?: string[];
  limit?: number;
  now?: Date;
  marketRegime?: MarketRegimeSnapshot | null;
}

export async function buildOpportunityScan(input: BuildOpportunityScanInput): Promise<OpportunityScan> {
  const now = input.now ?? new Date();
  const universe = [...new Set((input.universe ?? [...DEFAULT_OPPORTUNITY_UNIVERSE]).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
    .slice(0, Math.min(Math.max(input.limit ?? 75, 1), 75));
  const candidates: OpportunityCandidate[] = [];
  const skipped: OpportunityScan["skipped"] = [];

  for (const symbol of universe) {
    try {
      const bars = await input.getBars(symbol);
      const snapshot = buildSignalSnapshot(symbol, bars, input.riskProfile);
      candidates.push(scoreOpportunityCandidate(snapshot, input.riskSettings, now, input.marketRegime));
    } catch (error) {
      skipped.push({
        symbol,
        reason: error instanceof Error ? error.message : "Unable to load market data."
      });
    }
  }

  const ranked = candidates
    .sort((left, right) => right.opportunityScore - left.opportunityScore || right.riskAdjustedScore - left.riskAdjustedScore)
    .slice(0, 20)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1
    }));

  return {
    id: `opportunity-${dateKey(now)}-${now.getTime()}`,
    createdAt: now.toISOString(),
    dateKey: dateKey(now),
    universe,
    candidates: ranked,
    skipped
  };
}

export function scoreOpportunityCandidate(
  snapshot: SignalSnapshot,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">,
  now = new Date(),
  marketRegime?: MarketRegimeSnapshot | null
): OpportunityCandidate {
  const ranking = rankSignalSnapshot({ snapshot, riskSettings, marketRegime, now });
  const category = getOpportunityCategory(snapshot);
  const direction = getDirection(category);
  const atrPct = snapshot.lastPrice && snapshot.atr14 ? round(snapshot.atr14 / snapshot.lastPrice, 4) : null;
  const upsidePct = snapshot.lastPrice && snapshot.suggestedTarget
    ? round((snapshot.suggestedTarget - snapshot.lastPrice) / snapshot.lastPrice, 4)
    : null;
  const riskReward = snapshot.riskReward ?? null;
  const directionalBase = getDirectionalBase(snapshot, category);
  const rrBonus = riskReward ? riskReward >= riskSettings.minRiskReward ? Math.min(18, riskReward * 6) : -16 : -12;
  const upsideBonus = shouldUseDirectionalUpside(category)
    ? upsidePct ? Math.min(14, Math.max(-8, upsidePct * 180)) : -8
    : 0;
  const volumeBonus = snapshot.volumeRatio ? Math.min(10, Math.max(-6, (snapshot.volumeRatio - 1) * 10)) : -2;
  const trendBonus = getTrendBonus(snapshot, category);
  const volatilityBonus = getVolatilityBonus(atrPct, category);
  const penalties = getOpportunityPenalties(snapshot, riskSettings, now);
  const penaltyTotal = penalties.reduce((sum, item) => sum + item.value, 0);
  const opportunityScore = clampScore((directionalBase + ranking.adjustedScore) / 2 + rrBonus + upsideBonus + volumeBonus + trendBonus + volatilityBonus - penaltyTotal);
  const riskAdjustedScore = clampScore(
    ranking.adjustedScore +
      rrBonus +
      Math.min(8, Math.max(-6, (snapshot.volumeRatio ?? 1) * 4 - 4)) -
      penaltyTotal -
      (atrPct && atrPct > 0.06 ? 8 : 0)
  );

  return {
    symbol: snapshot.symbol,
    rank: 0,
    category,
    direction,
    opportunityScore,
    riskAdjustedScore,
    setupScore: snapshot.score,
    lastPrice: snapshot.lastPrice,
    riskReward,
    upsidePct,
    atrPct,
    volumeRatio: snapshot.volumeRatio,
    trend: snapshot.trend,
    bias: snapshot.bias,
    reason: buildOpportunityReason(snapshot, category, riskReward, upsidePct),
    warnings: [...new Set([...buildOpportunityWarnings(snapshot, riskSettings, now), ...ranking.warnings])],
    ranking,
    snapshot
  };
}

export function dateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getOpportunityCategory(snapshot: SignalSnapshot): OpportunityCategory {
  if (snapshot.trend === "insufficient_data" || !snapshot.lastPrice) return "watch_only";
  const atrPct = snapshot.lastPrice && snapshot.atr14 ? snapshot.atr14 / snapshot.lastPrice : 0;
  const bullish = snapshot.bias === "bullish" || snapshot.trend === "uptrend";
  const bearish = snapshot.bias === "bearish" || snapshot.trend === "downtrend" || snapshot.score <= 38;
  const range = snapshot.trend === "range" || snapshot.bias === "neutral";

  if (bullish && atrPct >= 0.025 && snapshot.score >= 68) return "bullish_options";
  if (bearish && atrPct >= 0.025) return "bearish_options";
  if (bullish) return "bullish_long";
  if (bearish) return "bearish_short";
  if (range && atrPct >= 0.012) return "neutral_income";
  return "watch_only";
}

function getDirection(category: OpportunityCategory): OpportunityCandidate["direction"] {
  if (category === "bullish_long" || category === "bullish_options") return "bullish";
  if (category === "bearish_short" || category === "bearish_options") return "bearish";
  if (category === "neutral_income") return "income";
  return "neutral";
}

function getDirectionalBase(snapshot: SignalSnapshot, category: OpportunityCategory): number {
  if (category === "bearish_short" || category === "bearish_options") return 100 - snapshot.score;
  if (category === "neutral_income" || category === "watch_only") return 100 - Math.min(45, Math.abs(snapshot.score - 50) * 1.4);
  return snapshot.score;
}

function getTrendBonus(snapshot: SignalSnapshot, category: OpportunityCategory): number {
  if ((category === "bullish_long" || category === "bullish_options") && snapshot.trend === "uptrend") return 10;
  if ((category === "bearish_short" || category === "bearish_options") && snapshot.trend === "downtrend") return 10;
  if (category === "neutral_income" && snapshot.trend === "range") return 8;
  if (snapshot.trend === "insufficient_data") return -18;
  return 0;
}

function getVolatilityBonus(atrPct: number | null, category: OpportunityCategory): number {
  if (!atrPct) return -2;
  if (category === "bullish_options" || category === "bearish_options") {
    if (atrPct >= 0.025 && atrPct <= 0.075) return 10;
    return -4;
  }
  if (category === "neutral_income") {
    if (atrPct >= 0.012 && atrPct <= 0.045) return 7;
    return -3;
  }
  if (atrPct > 0.08) return -8;
  if (atrPct >= 0.012 && atrPct <= 0.045) return 4;
  return 0;
}

function shouldUseDirectionalUpside(category: OpportunityCategory): boolean {
  return category === "bullish_long" || category === "bullish_options" || category === "bearish_short" || category === "bearish_options";
}

function getOpportunityPenalties(
  snapshot: SignalSnapshot,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">,
  now: Date
): Array<{ label: string; value: number }> {
  const penalties: Array<{ label: string; value: number }> = [];
  const ageMinutes = (now.getTime() - new Date(snapshot.asOf).getTime()) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > riskSettings.maxDataAgeMinutes) penalties.push({ label: "stale data", value: 18 });
  if (!snapshot.lastPrice || !snapshot.suggestedStop || !snapshot.suggestedTarget) penalties.push({ label: "missing risk plan", value: 18 });
  if ((snapshot.riskReward ?? 0) > 0 && (snapshot.riskReward ?? 0) < riskSettings.minRiskReward) penalties.push({ label: "low risk/reward", value: 12 });
  if (snapshot.rsi14 !== null && snapshot.rsi14 > 78) penalties.push({ label: "extended RSI", value: 10 });
  if (snapshot.volumeRatio !== null && snapshot.volumeRatio < 0.65) penalties.push({ label: "weak volume", value: 6 });
  if (snapshot.trend === "insufficient_data") penalties.push({ label: "insufficient history", value: 20 });
  return penalties;
}

function buildOpportunityWarnings(
  snapshot: SignalSnapshot,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">,
  now: Date
): string[] {
  return getOpportunityPenalties(snapshot, riskSettings, now).map((penalty) => {
    if (penalty.label === "stale data") return `Signal data is older than ${riskSettings.maxDataAgeMinutes} minutes.`;
    if (penalty.label === "missing risk plan") return "Missing stop, target, or reference price.";
    if (penalty.label === "low risk/reward") return `Risk/reward is below ${riskSettings.minRiskReward}:1.`;
    if (penalty.label === "extended RSI") return "RSI is extended; avoid chasing.";
    if (penalty.label === "weak volume") return "Recent volume is weak.";
    return "Insufficient history for full confirmation.";
  });
}

function buildOpportunityReason(
  snapshot: SignalSnapshot,
  category: OpportunityCategory,
  riskReward: number | null,
  upsidePct: number | null
): string {
  const rrText = riskReward ? `${riskReward}:1 risk/reward` : "risk/reward is not fully formed";
  const upsideText = upsidePct ? `${round(upsidePct * 100, 1)}% target room` : "limited target visibility";
  if (category === "bullish_long") return `Bullish trend setup with ${rrText} and ${upsideText}.`;
  if (category === "bearish_short") return `Weak technical structure makes this a short-side research candidate; ${rrText}.`;
  if (category === "bullish_options") return `Bullish setup with enough movement potential for options research; ${upsideText}.`;
  if (category === "bearish_options") return `Bearish setup with enough volatility for put or spread research.`;
  if (category === "neutral_income") return `Range-like setup that may be better for income or defined-risk options research.`;
  return `Watch only until the setup has cleaner trend, volume, and risk/reward confirmation.`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
