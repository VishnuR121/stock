import { describe, expect, it } from "vitest";
import { buildSafetyBlockers, buildSpecialistReports } from "../server/analysis";
import { getDefaultRiskSettings } from "../server/storage";
import type { SignalSnapshot, TradeContext } from "../src/shared/types";

describe("V2 analysis reports", () => {
  it("blocks analysis when the kill switch is enabled", () => {
    const blockers = buildSafetyBlockers({
      mode: "fast",
      snapshot: makeSnapshot(),
      context: makeContext(),
      options: [],
      account: { equity: 100000 },
      positions: [],
      journal: [],
      riskSettings: { ...getDefaultRiskSettings(), killSwitchEnabled: true },
      marketSnapshots: []
    });

    expect(blockers.some((blocker) => blocker.code === "kill_switch" && blocker.severity === "blocker")).toBe(true);
  });

  it("creates deterministic specialist reports without OpenAI", () => {
    const reports = buildSpecialistReports({
      mode: "fast",
      snapshot: makeSnapshot(),
      context: makeContext(),
      options: [],
      account: { equity: 100000 },
      positions: [{ symbol: "AAPL" }],
      journal: [],
      riskSettings: getDefaultRiskSettings(),
      marketSnapshots: []
    });

    expect(reports.map((report) => report.kind)).toEqual(["technical", "market", "fundamentals", "options", "risk", "journal"]);
    expect(reports.find((report) => report.kind === "risk")?.warnings.join(" ")).toMatch(/Existing position/);
  });
});

function makeSnapshot(): SignalSnapshot {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date(Date.now() - (40 - index) * 86400000).toISOString(),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1000000
  }));

  return {
    symbol: "AAPL",
    asOf: new Date().toISOString(),
    lastPrice: 140,
    previousClose: 139,
    sma20: 130,
    sma50: 120,
    sma200: 110,
    rsi14: 62,
    atr14: 4,
    volumeRatio: 1.1,
    recentHigh: 142,
    recentLow: 132,
    suggestedStop: 132,
    suggestedTarget: 154,
    riskReward: 1.75,
    trend: "uptrend",
    bias: "bullish",
    score: 82,
    positionSizeShares: 100,
    positionNotional: 14000,
    riskDollars: 800,
    notes: ["Price is stacked above key moving averages."],
    bars
  };
}

function makeContext(): TradeContext {
  return {
    symbol: "AAPL",
    generatedAt: new Date().toISOString(),
    providers: {
      alpaca: "ok",
      alphaVantage: "missing_key",
      sec: "not_found"
    },
    news: [],
    recentFilings: [],
    contextWarnings: []
  };
}
