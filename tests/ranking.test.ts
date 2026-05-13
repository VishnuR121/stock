import { describe, expect, it } from "vitest";
import { rankSignalSnapshot, rankSignalSnapshots } from "../server/ranking";
import { getDefaultRiskSettings } from "../server/storage";
import type { MarketRegimeSnapshot, SignalSnapshot } from "../src/shared/types";

describe("shared ranking model", () => {
  it("explains component scores for a clean bullish setup", () => {
    const ranking = rankSignalSnapshot({
      snapshot: makeSnapshot({ symbol: "AAPL", score: 84, trend: "uptrend", bias: "bullish", riskReward: 2.4 }),
      riskSettings: getDefaultRiskSettings(),
      marketRegime: makeRegime("bullish")
    });

    expect(ranking.action).toBe("buy");
    expect(ranking.adjustedScore).toBeGreaterThanOrEqual(ranking.rawScore);
    expect(ranking.components.trendScore).toBeGreaterThan(80);
    expect(ranking.reasons.join(" ")).toMatch(/Trend component/);
  });

  it("reduces long setup quality in bearish market regimes", () => {
    const settings = getDefaultRiskSettings();
    const bullish = makeSnapshot({ symbol: "AAPL", score: 84, trend: "uptrend", bias: "bullish", riskReward: 2.4 });
    const supportive = rankSignalSnapshot({ snapshot: bullish, riskSettings: settings, marketRegime: makeRegime("bullish") });
    const bearish = rankSignalSnapshot({ snapshot: bullish, riskSettings: settings, marketRegime: makeRegime("bearish") });

    expect(bearish.adjustedScore).toBeLessThan(supportive.adjustedScore);
    expect(bearish.warnings.join(" ")).toMatch(/Bearish market regime/);
  });

  it("assigns ranks by adjusted score", () => {
    const settings = getDefaultRiskSettings();
    const rankings = rankSignalSnapshots([
      { snapshot: makeSnapshot({ symbol: "LOW", score: 45, trend: "range", bias: "neutral", riskReward: 0.9 }), riskSettings: settings },
      { snapshot: makeSnapshot({ symbol: "HIGH", score: 86, trend: "uptrend", bias: "bullish", riskReward: 2.6 }), riskSettings: settings }
    ]);

    expect(rankings[0].symbol).toBe("HIGH");
    expect(rankings[0].rank).toBe(1);
    expect(rankings[1].rank).toBe(2);
  });
});

function makeRegime(regime: MarketRegimeSnapshot["regime"]): MarketRegimeSnapshot {
  return {
    regime,
    score: regime === "bullish" ? 78 : regime === "bearish" ? 32 : 55,
    explanation: `${regime} test regime`,
    riskAdjustmentMultiplier: regime === "bullish" ? 1 : regime === "bearish" ? 0.25 : 0.5,
    warnings: [],
    generatedAt: "2026-05-13T14:00:00.000Z",
    components: []
  };
}

function makeSnapshot(patch: Partial<SignalSnapshot> = {}): SignalSnapshot {
  const bars = Array.from({ length: 260 }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      timestamp: new Date(Date.now() - (260 - index) * 86400000).toISOString(),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000000 + index * 1000
    };
  });

  return {
    symbol: "AAPL",
    asOf: new Date().toISOString(),
    lastPrice: 150,
    previousClose: 148,
    sma20: 142,
    sma50: 135,
    sma200: 120,
    rsi14: 58,
    atr14: 4,
    volumeRatio: 1.25,
    recentHigh: 152,
    recentLow: 140,
    suggestedStop: 140,
    suggestedTarget: 174,
    riskReward: 2.4,
    trend: "uptrend",
    bias: "bullish",
    score: 84,
    positionSizeShares: 100,
    positionNotional: 15000,
    riskDollars: 1000,
    notes: [],
    bars,
    ...patch
  };
}
