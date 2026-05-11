import type { Bar, RiskProfile, SignalBias, SignalSnapshot, TrendState } from "../src/shared/types";

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return round(slice.reduce((sum, value) => sum + value, 0) / period, 2);
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;

  const deltas = values.slice(1).map((value, index) => value - values[index]);
  const first = deltas.slice(0, period);
  let averageGain = first.reduce((sum, delta) => sum + Math.max(delta, 0), 0) / period;
  let averageLoss = first.reduce((sum, delta) => sum + Math.max(-delta, 0), 0) / period;

  for (const delta of deltas.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return round(100 - 100 / (1 + relativeStrength), 2);
}

export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null;

  const trueRanges = bars.slice(1).map((bar, index) => {
    const previousClose = bars[index].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  });

  const initial = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const smoothed = trueRanges.slice(period).reduce((value, trueRange) => {
    return (value * (period - 1) + trueRange) / period;
  }, initial);

  return round(smoothed, 2);
}

export function buildSignalSnapshot(symbol: string, bars: Bar[], riskProfile: RiskProfile): SignalSnapshot {
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume);
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const lastPrice = latest?.close ?? null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const volumeBase = sma(volumes.slice(0, -1), 20);
  const volumeRatio = latest && volumeBase ? round(latest.volume / volumeBase, 2) : null;
  const recentBars = bars.slice(-20);
  const recentHigh = recentBars.length ? round(Math.max(...recentBars.map((bar) => bar.high)), 2) : null;
  const recentLow = recentBars.length ? round(Math.min(...recentBars.map((bar) => bar.low)), 2) : null;
  const trend = determineTrend(lastPrice, sma20, sma50, sma200);
  const suggestedStop = getSuggestedStop(lastPrice, recentLow, atr14);
  const suggestedTarget = getSuggestedTarget(lastPrice, recentHigh, atr14);
  const riskReward = getRiskReward(lastPrice, suggestedStop, suggestedTarget);
  const bias = determineBias(trend, rsi14, volumeRatio, riskReward);
  const score = getScore({ trend, rsi14, volumeRatio, riskReward, lastPrice, sma20, sma50, sma200 });
  const sizing = getConservativePositionSize(lastPrice, suggestedStop, riskProfile);

  return {
    symbol,
    asOf: latest?.timestamp ?? new Date().toISOString(),
    lastPrice,
    previousClose: previous?.close ?? null,
    sma20,
    sma50,
    sma200,
    rsi14,
    atr14,
    volumeRatio,
    recentHigh,
    recentLow,
    suggestedStop,
    suggestedTarget,
    riskReward,
    trend,
    bias,
    score,
    positionSizeShares: sizing.shares,
    positionNotional: sizing.notional,
    riskDollars: sizing.riskDollars,
    notes: buildNotes(trend, rsi14, volumeRatio, riskReward, suggestedStop, suggestedTarget),
    bars
  };
}

export function getDefaultRiskProfile(accountEquity = 100000): RiskProfile {
  return {
    accountEquity,
    maxRiskPerTradePct: 0.01,
    maxPositionPct: 0.1,
    maxDailyLossPct: 0.03,
    minRiskReward: 1.5
  };
}

function determineTrend(
  lastPrice: number | null,
  sma20Value: number | null,
  sma50Value: number | null,
  sma200Value: number | null
): TrendState {
  if (!lastPrice || !sma20Value || !sma50Value || !sma200Value) return "insufficient_data";
  if (lastPrice > sma20Value && sma20Value > sma50Value && sma50Value > sma200Value) return "uptrend";
  if (lastPrice < sma20Value && sma20Value < sma50Value && sma50Value < sma200Value) return "downtrend";
  return "range";
}

function determineBias(
  trend: TrendState,
  rsi14: number | null,
  volumeRatio: number | null,
  riskReward: number | null
): SignalBias {
  if (trend === "downtrend" || (rsi14 !== null && rsi14 > 78)) return "bearish";
  if (trend === "uptrend" && rsi14 !== null && rsi14 >= 45 && rsi14 <= 70 && (riskReward ?? 0) >= 1.5) {
    return volumeRatio !== null && volumeRatio < 0.65 ? "caution" : "bullish";
  }
  if (trend === "insufficient_data") return "caution";
  return "neutral";
}

function getScore(input: {
  trend: TrendState;
  rsi14: number | null;
  volumeRatio: number | null;
  riskReward: number | null;
  lastPrice: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
}): number {
  let score = 50;
  if (input.trend === "uptrend") score += 22;
  if (input.trend === "downtrend") score -= 24;
  if (input.trend === "range") score -= 2;
  if (input.rsi14 !== null && input.rsi14 >= 45 && input.rsi14 <= 65) score += 12;
  if (input.rsi14 !== null && input.rsi14 > 75) score -= 18;
  if ((input.volumeRatio ?? 0) > 1.2) score += 8;
  if ((input.riskReward ?? 0) >= 2) score += 10;
  if ((input.riskReward ?? 0) > 0 && (input.riskReward ?? 0) < 1.2) score -= 12;
  if (input.lastPrice && input.sma200 && input.lastPrice > input.sma200) score += 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getSuggestedStop(lastPrice: number | null, recentLow: number | null, atr14: number | null): number | null {
  if (!lastPrice || !recentLow || !atr14) return null;
  return round(Math.min(recentLow, lastPrice - atr14 * 1.5), 2);
}

function getSuggestedTarget(lastPrice: number | null, recentHigh: number | null, atr14: number | null): number | null {
  if (!lastPrice || !atr14) return null;
  const targetByAtr = lastPrice + atr14 * 3;
  const targetByBreakout = recentHigh && recentHigh > lastPrice ? recentHigh + atr14 : targetByAtr;
  return round(Math.max(targetByAtr, targetByBreakout), 2);
}

function getRiskReward(lastPrice: number | null, stop: number | null, target: number | null): number | null {
  if (!lastPrice || !stop || !target) return null;
  const risk = lastPrice - stop;
  const reward = target - lastPrice;
  if (risk <= 0 || reward <= 0) return null;
  return round(reward / risk, 2);
}

function getConservativePositionSize(
  lastPrice: number | null,
  stop: number | null,
  riskProfile: RiskProfile
): { shares: number | null; notional: number | null; riskDollars: number | null } {
  if (!lastPrice || !stop || stop >= lastPrice || riskProfile.accountEquity <= 0) {
    return { shares: null, notional: null, riskDollars: null };
  }
  const maxRiskDollars = riskProfile.accountEquity * riskProfile.maxRiskPerTradePct;
  const maxNotional = riskProfile.accountEquity * riskProfile.maxPositionPct;
  const riskPerShare = lastPrice - stop;
  const sharesByRisk = Math.floor(maxRiskDollars / riskPerShare);
  const sharesByNotional = Math.floor(maxNotional / lastPrice);
  const shares = Math.max(0, Math.min(sharesByRisk, sharesByNotional));
  return {
    shares,
    notional: shares > 0 ? round(shares * lastPrice, 2) : 0,
    riskDollars: shares > 0 ? round(shares * riskPerShare, 2) : 0
  };
}

function buildNotes(
  trend: TrendState,
  rsi14: number | null,
  volumeRatio: number | null,
  riskReward: number | null,
  stop: number | null,
  target: number | null
): string[] {
  const notes: string[] = [];
  if (trend === "uptrend") notes.push("Price is stacked above key moving averages.");
  if (trend === "downtrend") notes.push("Trend is weak; avoid long entries unless conditions improve.");
  if (trend === "range") notes.push("Trend is mixed; wait for cleaner support/resistance behavior.");
  if (trend === "insufficient_data") notes.push("Not enough history for full moving-average confirmation.");
  if (rsi14 !== null && rsi14 > 75) notes.push("RSI is extended; consider patience or smaller sizing.");
  if (rsi14 !== null && rsi14 < 35) notes.push("RSI is weak; mean reversion is possible but trend confirmation matters.");
  if (volumeRatio !== null && volumeRatio > 1.3) notes.push("Volume is meaningfully above recent average.");
  if (riskReward !== null && riskReward < 1.5) notes.push("Risk/reward is below the conservative minimum.");
  if (stop && target) notes.push(`Draft plan uses stop ${stop} and target ${target}.`);
  return notes;
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
