import { describe, expect, it } from "vitest";
import { buildOpportunityScan, scoreOpportunityCandidate } from "../server/opportunities";
import { getDefaultRiskSettings } from "../server/storage";
import type { Bar, SignalSnapshot } from "../src/shared/types";

describe("opportunity scoring", () => {
  it("ranks bullish setups with clean risk higher than watch-only setups", () => {
    const settings = getDefaultRiskSettings();
    const bullish = scoreOpportunityCandidate(makeSnapshot({ symbol: "AAPL", score: 84, trend: "uptrend", bias: "bullish", riskReward: 2.2 }), settings);
    const watch = scoreOpportunityCandidate(makeSnapshot({ symbol: "MSFT", score: 45, trend: "range", bias: "neutral", riskReward: 0.8 }), settings);

    expect(bullish.category).toMatch(/bullish/);
    expect(bullish.opportunityScore).toBeGreaterThan(watch.opportunityScore);
    expect(bullish.ranking.components.trendScore).toBeGreaterThan(80);
    expect(bullish.ranking.action).toBe("buy");
    expect(watch.warnings.join(" ")).toMatch(/Risk\/reward/);
  });

  it("classifies downtrends as bearish research candidates", () => {
    const candidate = scoreOpportunityCandidate(makeSnapshot({ score: 22, trend: "downtrend", bias: "bearish", riskReward: 1.8 }), getDefaultRiskSettings());

    expect(candidate.category).toMatch(/bearish/);
    expect(candidate.direction).toBe("bearish");
    expect(candidate.opportunityScore).toBeGreaterThan(50);
  });

  it("continues scanning when one symbol fails", async () => {
    const scan = await buildOpportunityScan({
      universe: ["AAPL", "BAD", "MSFT"],
      limit: 3,
      riskProfile: {
        accountEquity: 100000,
        maxRiskPerTradePct: 0.01,
        maxPositionPct: 0.1,
        maxDailyLossPct: 0.03,
        minRiskReward: 1.5
      },
      riskSettings: getDefaultRiskSettings(),
      getBars: async (symbol) => {
        if (symbol === "BAD") throw new Error("missing data");
        return makeBars(symbol === "AAPL" ? 1 : 0.2);
      }
    });

    expect(scan.candidates.map((candidate) => candidate.symbol)).toContain("AAPL");
    expect(scan.skipped).toEqual([{ symbol: "BAD", reason: "missing data" }]);
  });
});

function makeSnapshot(patch: Partial<SignalSnapshot> = {}): SignalSnapshot {
  const bars = makeBars(1);
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
    suggestedTarget: 172,
    riskReward: 2.2,
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

function makeBars(slope: number): Bar[] {
  return Array.from({ length: 260 }, (_, index) => {
    const close = 100 + index * slope;
    return {
      timestamp: new Date(Date.now() - (260 - index) * 86400000).toISOString(),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000000 + index * 1000
    };
  });
}
