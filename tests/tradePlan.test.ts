import { describe, expect, it } from "vitest";
import { buildDeterministicTradePlan } from "../server/tradePlan";
import { getDefaultRiskSettings } from "../server/storage";
import type { MarketRegimeSnapshot, SignalSnapshot } from "../src/shared/types";

describe("deterministic trade plan", () => {
  it("uses ranking and risk settings as the source of truth", () => {
    const plan = buildDeterministicTradePlan({
      snapshot: makeSnapshot(),
      riskSettings: getDefaultRiskSettings(),
      marketRegime: makeRegime("bullish"),
      now: new Date("2026-05-13T14:00:00.000Z")
    });

    expect(plan.action).toBe("paper_long_candidate");
    expect(plan.ranking.action).toBe("buy");
    expect(plan.entryZone.low).toBeLessThan(plan.currentPrice ?? 0);
    expect(plan.stopLoss).toBe(140);
    expect(plan.conservativeTarget).toBe(174);
    expect(plan.maxRiskDollars).toBe(1000);
    expect(plan.keyRisks.join(" ")).toMatch(/paper-trading research/);
  });

  it("reduces sizing and warns in bearish market regimes", () => {
    const plan = buildDeterministicTradePlan({
      snapshot: makeSnapshot(),
      riskSettings: getDefaultRiskSettings(),
      marketRegime: makeRegime("bearish")
    });

    expect(plan.positionSizeShares).toBe(25);
    expect(plan.maxRiskDollars).toBe(250);
    expect(plan.action).not.toBe("paper_long_candidate");
    expect([...plan.keyRisks, ...plan.warnings].join(" ")).toMatch(/bearish/i);
  });
});

function makeRegime(regime: MarketRegimeSnapshot["regime"]): MarketRegimeSnapshot {
  return {
    regime,
    score: regime === "bullish" ? 78 : 32,
    explanation: `${regime} test regime`,
    riskAdjustmentMultiplier: regime === "bullish" ? 1 : 0.25,
    warnings: regime === "bearish" ? ["Bearish regime test warning."] : [],
    generatedAt: "2026-05-13T14:00:00.000Z",
    components: []
  };
}

function makeSnapshot(patch: Partial<SignalSnapshot> = {}): SignalSnapshot {
  const bars = Array.from({ length: 260 }, (_, index) => {
    const close = 100 + index * 0.5;
    return {
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000000 + index * 1000
    };
  });

  return {
    symbol: "AAPL",
    asOf: "2026-05-13T14:00:00.000Z",
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
