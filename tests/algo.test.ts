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
    expect(long?.horizon).toBe("swing");
    expect(long?.expectedHoldingPeriod).toMatch(/days/i);
    expect(long?.order?.symbol).toBe("AAPL");
    expect(long?.order?.timeInForce).toBe("gtc");
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
    expect(short?.horizon).toBe("swing");
    expect(short?.order?.timeInForce).toBe("gtc");
    expect(short?.order?.side).toBe("sell");
    expect(short?.order?.stopLossPrice).toBeGreaterThan(100);
    expect(short?.order?.takeProfitPrice).toBeLessThan(100);
  });

  it("classifies option proposals with no selected contract as needs contract selection", () => {
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

    const optionProposal = proposals.find((proposal) => ["long_call", "long_put", "call_debit_spread", "put_debit_spread", "covered_call", "cash_secured_put"].includes(proposal.strategyKind));
    expect(optionProposal?.executable).toBe(false);
    expect(optionProposal?.workflowStatus).toBe("needs_contract_selection");
    expect(optionProposal?.horizon).toBe("options_short_term");
    expect(optionProposal?.multiLegOrder).toBeUndefined();
    expect(optionProposal?.howToFix?.join(" ")).toMatch(/No option contracts|Select exact option/i);
  });

  it("promotes a valid long call contract to internal paper simulation eligibility", () => {
    const settings = getDefaultRiskSettings();
    const analysisRun = buildAnalysisRun({
      mode: "fast",
      snapshot: makeSnapshot(),
      context: makeContext(),
      options: makeOptions(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      positions: [],
      journal: [],
      riskSettings: settings,
      marketSnapshots: []
    });

    const proposals = buildAlgoTradeProposals({
      analysisRun,
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      riskSettings: settings,
      referencePrice: 140,
      now: new Date("2026-05-14T15:00:00.000Z")
    });

    const call = proposals.find((proposal) => proposal.strategyKind === "long_call");
    expect(call?.workflowStatus).toBe("paper_eligible");
    expect(call?.executionType).toBe("internal_options_simulation");
    expect(call?.multiLegOrder?.legs[0].optionSymbol).toBe("AAPL260619C00145000");
    expect(call?.selectedContracts?.[0].side).toBe("buy");
    expect(call?.paperExecutionMode).toBe("internal_simulation");
  });

  it("calculates valid debit spread metrics inside algo proposals", () => {
    const settings = getDefaultRiskSettings();
    const analysisRun = buildAnalysisRun({
      mode: "fast",
      snapshot: makeSnapshot(),
      context: makeContext(),
      options: makeOptions(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      positions: [],
      journal: [],
      riskSettings: settings,
      marketSnapshots: []
    });

    const proposals = buildAlgoTradeProposals({
      analysisRun,
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      riskSettings: settings,
      referencePrice: 140,
      now: new Date("2026-05-14T15:00:00.000Z")
    });

    const spread = proposals.find((proposal) => proposal.strategyKind === "call_debit_spread");
    expect(spread?.workflowStatus).toBe("paper_eligible");
    expect(spread?.maxLoss).toBe(220);
    expect(spread?.maxProfit).toBe(280);
    expect(spread?.breakeven).toBe(147.2);
    expect(spread?.selectedContracts).toHaveLength(2);
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

function makeOptions() {
  return [
    {
      symbol: "AAPL260619C00145000",
      underlyingSymbol: "AAPL",
      type: "call" as const,
      expirationDate: "2026-06-19",
      strikePrice: 145,
      closePrice: 4.5,
      bidPrice: 4.4,
      askPrice: 4.6,
      openInterest: 250,
      volume: 100,
      breakeven: 149.5,
      maxLoss: 450,
      liquidityWarning: null
    },
    {
      symbol: "AAPL260619C00150000",
      underlyingSymbol: "AAPL",
      type: "call" as const,
      expirationDate: "2026-06-19",
      strikePrice: 150,
      closePrice: 2.3,
      bidPrice: 2.2,
      askPrice: 2.4,
      openInterest: 240,
      volume: 90,
      breakeven: 152.3,
      maxLoss: 230,
      liquidityWarning: null
    }
  ];
}
