import type { MarketRegimeSnapshot, RankedSetup, RankingAction, RankingComponents, RiskSettings, SignalBias, SignalSnapshot } from "../src/shared/types";
import { round } from "./indicators";

interface RankSignalInput {
  snapshot: SignalSnapshot;
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">;
  marketRegime?: MarketRegimeSnapshot | null;
  now?: Date;
}

export function rankSignalSnapshot(input: RankSignalInput): RankedSetup {
  const now = input.now ?? new Date();
  const components = buildRankingComponents(input.snapshot, input.riskSettings, input.marketRegime);
  const rawScore = getRawScore(components);
  const adjustedScore = clampScore(rawScore + components.marketRegimeAdjustment - getWarningPenalty(input.snapshot, input.riskSettings, now));
  const warnings = buildRankingWarnings(input.snapshot, input.riskSettings, input.marketRegime, now);
  const action = getRankingAction(input.snapshot, adjustedScore, warnings);

  return {
    symbol: input.snapshot.symbol,
    rawScore,
    adjustedScore,
    rank: 0,
    action,
    bias: getRankingBias(input.snapshot.bias, adjustedScore, input.marketRegime),
    reasons: buildRankingReasons(input.snapshot, components, input.marketRegime),
    warnings,
    suggestedStop: input.snapshot.suggestedStop,
    suggestedTarget: input.snapshot.suggestedTarget,
    riskReward: input.snapshot.riskReward,
    components
  };
}

export function rankSignalSnapshots(input: RankSignalInput[]): RankedSetup[] {
  return input
    .map(rankSignalSnapshot)
    .sort((left, right) => right.adjustedScore - left.adjustedScore || right.rawScore - left.rawScore || left.symbol.localeCompare(right.symbol))
    .map((ranking, index) => ({ ...ranking, rank: index + 1 }));
}

function buildRankingComponents(
  snapshot: SignalSnapshot,
  riskSettings: Pick<RiskSettings, "minRiskReward">,
  marketRegime?: MarketRegimeSnapshot | null
): RankingComponents {
  return {
    trendScore: scoreTrend(snapshot),
    momentumScore: scoreMomentum(snapshot),
    riskRewardScore: scoreRiskReward(snapshot.riskReward, riskSettings.minRiskReward),
    volumeScore: scoreVolume(snapshot.volumeRatio),
    volatilityScore: scoreVolatility(snapshot),
    rsiQualityScore: scoreRsi(snapshot.rsi14),
    marketRegimeAdjustment: getMarketRegimeAdjustment(marketRegime)
  };
}

function getRawScore(components: RankingComponents): number {
  return clampScore(
    components.trendScore * 0.28 +
    components.momentumScore * 0.18 +
    components.riskRewardScore * 0.2 +
    components.volumeScore * 0.12 +
    components.volatilityScore * 0.1 +
    components.rsiQualityScore * 0.12
  );
}

function scoreTrend(snapshot: SignalSnapshot): number {
  if (!snapshot.lastPrice || !snapshot.sma20 || !snapshot.sma50 || !snapshot.sma200) return 35;
  if (snapshot.trend === "uptrend") return 90;
  if (snapshot.trend === "downtrend") return 20;

  let score = 50;
  if (snapshot.lastPrice > snapshot.sma20) score += 10;
  if (snapshot.lastPrice > snapshot.sma50) score += 10;
  if (snapshot.lastPrice > snapshot.sma200) score += 12;
  if (snapshot.sma20 > snapshot.sma50) score += 8;
  return clampScore(score);
}

function scoreMomentum(snapshot: SignalSnapshot): number {
  const momentum20 = getPercentChange(snapshot.bars, 20);
  const momentum60 = getPercentChange(snapshot.bars, 60);
  if (momentum20 === null && momentum60 === null) return snapshot.score;

  let score = 50;
  if ((momentum20 ?? 0) >= 5) score += 18;
  else if ((momentum20 ?? 0) >= 1) score += 10;
  else if ((momentum20 ?? 0) < -3) score -= 16;
  else if ((momentum20 ?? 0) < 0) score -= 8;

  if ((momentum60 ?? 0) >= 10) score += 18;
  else if ((momentum60 ?? 0) >= 2) score += 10;
  else if ((momentum60 ?? 0) < -8) score -= 18;
  else if ((momentum60 ?? 0) < 0) score -= 8;

  return clampScore(score);
}

function scoreRiskReward(riskReward: number | null, minimum: number): number {
  if (!riskReward) return 30;
  if (riskReward >= minimum + 1) return 95;
  if (riskReward >= minimum) return 78;
  if (riskReward >= 1) return 45;
  return 20;
}

function scoreVolume(volumeRatio: number | null): number {
  if (volumeRatio === null) return 45;
  if (volumeRatio >= 1.4) return 90;
  if (volumeRatio >= 1.05) return 72;
  if (volumeRatio >= 0.75) return 52;
  return 28;
}

function scoreVolatility(snapshot: SignalSnapshot): number {
  if (!snapshot.lastPrice || !snapshot.atr14) return 45;
  const atrPct = snapshot.atr14 / snapshot.lastPrice;
  if (atrPct >= 0.08) return 20;
  if (atrPct >= 0.05) return 38;
  if (atrPct >= 0.015 && atrPct <= 0.04) return 82;
  if (atrPct < 0.008) return 48;
  return 64;
}

function scoreRsi(rsi14: number | null): number {
  if (rsi14 === null) return 45;
  if (rsi14 >= 45 && rsi14 <= 65) return 88;
  if (rsi14 > 65 && rsi14 <= 72) return 68;
  if (rsi14 >= 35 && rsi14 < 45) return 52;
  if (rsi14 > 78 || rsi14 < 30) return 22;
  return 38;
}

function getMarketRegimeAdjustment(marketRegime?: MarketRegimeSnapshot | null): number {
  if (!marketRegime) return 0;
  if (marketRegime.regime === "bullish") return 6;
  if (marketRegime.regime === "neutral") return -4;
  if (marketRegime.regime === "caution") return -14;
  return -28;
}

function getWarningPenalty(
  snapshot: SignalSnapshot,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">,
  now: Date
): number {
  let penalty = 0;
  const ageMinutes = (now.getTime() - new Date(snapshot.asOf).getTime()) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > riskSettings.maxDataAgeMinutes) penalty += 18;
  if (!snapshot.lastPrice || !snapshot.suggestedStop || !snapshot.suggestedTarget) penalty += 18;
  if ((snapshot.riskReward ?? 0) > 0 && (snapshot.riskReward ?? 0) < riskSettings.minRiskReward) penalty += 12;
  if (snapshot.rsi14 !== null && snapshot.rsi14 > 78) penalty += 10;
  return penalty;
}

function buildRankingWarnings(
  snapshot: SignalSnapshot,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">,
  marketRegime: MarketRegimeSnapshot | null | undefined,
  now: Date
): string[] {
  const warnings: string[] = [];
  const ageMinutes = (now.getTime() - new Date(snapshot.asOf).getTime()) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > riskSettings.maxDataAgeMinutes) warnings.push(`Signal data is older than ${riskSettings.maxDataAgeMinutes} minutes.`);
  if (!snapshot.lastPrice || !snapshot.suggestedStop || !snapshot.suggestedTarget) warnings.push("Missing stop, target, or reference price.");
  if ((snapshot.riskReward ?? 0) > 0 && (snapshot.riskReward ?? 0) < riskSettings.minRiskReward) warnings.push(`Risk/reward is below ${riskSettings.minRiskReward}:1.`);
  if (snapshot.rsi14 !== null && snapshot.rsi14 > 78) warnings.push("RSI is extended; avoid chasing.");
  if (snapshot.volumeRatio !== null && snapshot.volumeRatio < 0.65) warnings.push("Recent volume is weak.");
  if (snapshot.trend === "insufficient_data") warnings.push("Insufficient history for full confirmation.");
  if (marketRegime?.regime === "bearish") warnings.push("Bearish market regime reduces long setup quality.");
  if (marketRegime?.regime === "caution") warnings.push("Caution market regime requires smaller size and stronger confirmation.");
  return warnings;
}

function getRankingAction(snapshot: SignalSnapshot, adjustedScore: number, warnings: string[]): RankingAction {
  if (snapshot.bias === "bearish" || snapshot.trend === "downtrend" || adjustedScore < 45) return "avoid";
  if (warnings.some((warning) => /stale|missing stop|missing/i.test(warning))) return "avoid";
  if (adjustedScore >= 78 && snapshot.bias === "bullish") return "buy";
  if (adjustedScore >= 55) return "watch";
  return "hold";
}

function getRankingBias(
  snapshotBias: SignalBias,
  adjustedScore: number,
  marketRegime?: MarketRegimeSnapshot | null
): SignalBias {
  if (marketRegime?.regime === "bearish" && snapshotBias === "bullish") return "caution";
  if (adjustedScore < 45) return "bearish";
  if (adjustedScore < 60 && snapshotBias === "bullish") return "caution";
  return snapshotBias;
}

function buildRankingReasons(
  snapshot: SignalSnapshot,
  components: RankingComponents,
  marketRegime?: MarketRegimeSnapshot | null
): string[] {
  const reasons = [
    `Trend component: ${components.trendScore}/100.`,
    `Momentum component: ${components.momentumScore}/100.`,
    snapshot.riskReward ? `Risk/reward: ${snapshot.riskReward}:1.` : "Risk/reward is unavailable.",
    snapshot.volumeRatio ? `Volume ratio: ${snapshot.volumeRatio}.` : "Volume confirmation is unavailable."
  ];
  if (snapshot.lastPrice && snapshot.atr14) reasons.push(`ATR volatility: ${round((snapshot.atr14 / snapshot.lastPrice) * 100, 2)}% of price.`);
  if (marketRegime) reasons.push(`Market regime adjustment: ${components.marketRegimeAdjustment} (${marketRegime.regime}).`);
  return reasons;
}

function getPercentChange(bars: SignalSnapshot["bars"], lookback: number): number | null {
  const recent = bars.slice(-lookback - 1);
  const first = recent.at(0)?.close;
  const last = recent.at(-1)?.close;
  if (!first || !last) return null;
  return ((last - first) / first) * 100;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
