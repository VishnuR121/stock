import { describe, expect, it } from "vitest";
import { buildAnalysisRun } from "../server/analysis";
import { buildAlgoTradeProposals } from "../server/algo";
import { getDefaultRiskSettings } from "../server/storage";
import type { SignalSnapshot, TradeContext } from "../src/shared/types";

describe("algo trade proposals", () => {
  it("creates an executable long-stock proposal when the setup is clean", () => {
    const settings = getDefaultRiskSettings();
    const analysisRun = buildAnalysisRun({
      mode: "fast",
      snapshot: makeSnapshot(),
      context: makeContext(),
      options: [],
      account: { equity: 100000 },
      positions: [],
      journal: [],
      riskSettings: settings,
      marketSnapshots: []
    });

    const proposals = buildAlgoTradeProposals({
      analysisRun,
      account: { equity: 100000 },
      riskSettings: settings,
      referencePrice: 140
    });

    const long = proposals.find((proposal) => proposal.strategyKind === "long_stock");
    expect(long?.executable).toBe(true);
    expect(long?.executionType).toBe("long_stock_bracket");
    expect(long?.order?.symbol).toBe("AAPL");
    expect(long?.order?.confirmedPaperOnly).toBe(false);
  });

  it("creates an executable short-stock proposal from a bearish setup", () => {
    const settings = getDefaultRiskSettings();
    const analysisRun = buildAnalysisRun({
      mode: "fast",
      snapshot: makeBearishSnapshot(),
      context: makeContext(),
      options: [],
      account: { equity: 100000 },
      positions: [],
      journal: [],
      riskSettings: settings,
      marketSnapshots: []
    });

    const proposals = buildAlgoTradeProposals({
      analysisRun,
      account: { equity: 100000 },
      riskSettings: settings,
      referencePrice: 100
    });

    const short = proposals.find((proposal) => proposal.strategyKind === "short_stock");
    expect(short?.executable).toBe(true);
    expect(short?.executionType).toBe("short_stock_bracket");
    expect(short?.order?.side).toBe("sell");
    expect(short?.order?.stopLossPrice).toBeGreaterThan(100);
    expect(short?.order?.takeProfitPrice).toBeLessThan(100);
  });

  it("creates executable single-leg long option proposals when max loss fits risk", () => {
    const settings = getDefaultRiskSettings();
    const analysisRun = buildAnalysisRun({
      mode: "fast",
      snapshot: makeSnapshot(),
      context: makeContext(),
      options: [
        {
          symbol: "AAPL260619C00145000",
          underlyingSymbol: "AAPL",
          type: "call",
          expirationDate: "2026-06-19",
          strikePrice: 145,
          closePrice: 4.5,
          openInterest: 250,
          breakeven: 149.5,
          maxLoss: 450,
          liquidityWarning: null
        }
      ],
      account: { equity: 100000 },
      positions: [],
      journal: [],
      riskSettings: settings,
      marketSnapshots: []
    });

    const proposals = buildAlgoTradeProposals({
      analysisRun,
      account: { equity: 100000 },
      riskSettings: settings,
      referencePrice: 140
    });

    const call = proposals.find((proposal) => proposal.strategyKind === "long_call");
    expect(call?.executable).toBe(true);
    expect(call?.executionType).toBe("long_option");
    expect(call?.optionOrder?.contractSymbol).toBe("AAPL260619C00145000");
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
    positionSizeShares: 50,
    positionNotional: 7000,
    riskDollars: 400,
    notes: ["Price is stacked above key moving averages."],
    bars
  };
}

function makeBearishSnapshot(): SignalSnapshot {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date(Date.now() - (40 - index) * 86400000).toISOString(),
    open: 140 - index,
    high: 142 - index,
    low: 138 - index,
    close: 139 - index,
    volume: 1000000
  }));

  return {
    symbol: "AAPL",
    asOf: new Date().toISOString(),
    lastPrice: 100,
    previousClose: 102,
    sma20: 105,
    sma50: 112,
    sma200: 125,
    rsi14: 38,
    atr14: 4,
    volumeRatio: 1.2,
    recentHigh: 102,
    recentLow: 92,
    suggestedStop: 96,
    suggestedTarget: 88,
    riskReward: 2,
    trend: "downtrend",
    bias: "bearish",
    score: 24,
    positionSizeShares: 50,
    positionNotional: 5000,
    riskDollars: 400,
    notes: ["Trend is weak; avoid long entries unless conditions improve."],
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
