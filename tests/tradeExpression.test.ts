import { describe, expect, it } from "vitest";
import { buildTradeExpressionResult } from "../server/tradeExpression";
import { getDefaultRiskSettings } from "../server/storage";
import type { OptionIdea, SignalSnapshot } from "../src/shared/types";

const now = new Date("2026-05-14T15:00:00.000Z");

describe("trade expression engine", () => {
  it("recommends long equity for a bullish simple setup", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: makeOptions(),
      preference: "simple",
      now
    });

    expect(result.recommendedExpression.expressionType).toBe("long_equity");
    expect(result.recommendedExpression.status).toBe("paper_trade_allowed");
    expect(result.recommendedExpression.order?.side).toBe("buy");
  });

  it("recommends defined-risk bullish spreads when that preference is selected", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: makeOptions(),
      preference: "defined_risk",
      now
    });

    expect(result.recommendedExpression.expressionType).toBe("bull_call_debit_spread");
    expect(result.recommendedExpression.maxLoss).toBe(220);
    expect(result.recommendedExpression.maxProfit).toBe(280);
    expect(result.recommendedExpression.breakeven).toBe(147.2);
  });

  it("calculates long call and long put max loss and breakeven", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: makeOptions(),
      preference: "leverage",
      now
    });

    const call = [result.recommendedExpression, ...result.alternatives].find((expression) => expression.expressionType === "long_call");
    const put = [result.recommendedExpression, ...result.alternatives, ...result.blockedExpressions].find((expression) => expression.expressionType === "long_put");

    expect(call?.maxLoss).toBe(450);
    expect(call?.breakeven).toBe(149.5);
    expect(put?.maxLoss).toBe(310);
    expect(put?.breakeven).toBe(131.9);
  });

  it("calculates bear put debit spread risk metrics for bearish setups", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBearishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: makeOptions(),
      preference: "defined_risk",
      now
    });

    expect(result.recommendedExpression.expressionType).toBe("bear_put_debit_spread");
    expect(result.recommendedExpression.maxLoss).toBe(160);
    expect(result.recommendedExpression.maxProfit).toBe(340);
    expect(result.recommendedExpression.breakeven).toBe(133.4);
  });

  it("checks covered call share coverage and cash-secured put capital", () => {
    const noShares = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: makeOptions(),
      preference: "income",
      now
    });
    const coveredWithoutShares = noShares.blockedExpressions.find((expression) => expression.expressionType === "covered_call");
    expect(coveredWithoutShares?.statusReasons.join(" ")).toMatch(/100 long shares/);

    const withShares = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [{ symbol: "AAPL", qty: "100", side: "long" }],
      riskSettings: { ...getDefaultRiskSettings(), maxRiskPerTradePct: 0.2 },
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: makeOptions(),
      preference: "income",
      now
    });
    expect([withShares.recommendedExpression, ...withShares.alternatives].some((expression) => expression.expressionType === "covered_call")).toBe(true);

    const lowCash = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: { ...getDefaultRiskSettings(), maxStrategyExposurePct: 1 },
      account: { equity: 100000, buyingPower: 5000, cash: 5000, paper: true },
      options: makeOptions(),
      preference: "income",
      now
    });
    const csp = lowCash.blockedExpressions.find((expression) => expression.expressionType === "cash_secured_put");
    expect(csp?.statusReasons.join(" ")).toMatch(/collateral|capital/i);
  });

  it("warns on wide spreads and low liquidity", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: [
        makeOption({ symbol: "AAPL260619C00145000", type: "call", strikePrice: 145, closePrice: 4.5, bidPrice: 3, askPrice: 6, openInterest: 50 })
      ],
      preference: "leverage",
      now
    });

    const warnings = [...result.recommendedExpression.liquidityWarnings, ...result.blockedExpressions.flatMap((expression) => expression.liquidityWarnings)].join(" ");
    expect(warnings).toMatch(/Wide|open interest|spread/i);
  });

  it("explains why option contracts were not selected", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: [
        makeOption({ symbol: "AAPL260619C00145000", type: "call", strikePrice: 145, closePrice: 4.5, bidPrice: 4.4, askPrice: 4.6, openInterest: null })
      ],
      preference: "leverage",
      now
    });

    const call = result.blockedExpressions.find((expression) => expression.expressionType === "long_call");
    expect(call?.optionSelectionDiagnostics).toMatchObject({
      totalContracts: 1,
      typeMatches: 1,
      dteEligible: 1,
      priceEligible: 1,
      openInterestEligible: 0,
      candidatesConsidered: 0
    });
    expect(call?.optionSelectionDiagnostics?.rejectionReasons.join(" ")).toMatch(/open-interest/i);
  });

  it("explains why a debit spread short leg was not selected", () => {
    const result = buildTradeExpressionResult({
      snapshot: makeBullishSnapshot(),
      currentHoldings: [],
      riskSettings: getDefaultRiskSettings(),
      account: { equity: 100000, buyingPower: 100000, cash: 100000, paper: true },
      options: [
        makeOption({ symbol: "AAPL260619C00145000", type: "call", strikePrice: 145, closePrice: 4.5, bidPrice: 4.4, askPrice: 4.6, openInterest: 500 }),
        makeOption({ symbol: "AAPL260619C00135000", type: "call", strikePrice: 135, closePrice: 6.5, bidPrice: 6.4, askPrice: 6.6, openInterest: 500 })
      ],
      preference: "defined_risk",
      now
    });

    const spread = result.blockedExpressions.find((expression) => expression.expressionType === "bull_call_debit_spread");
    expect(spread?.optionSelectionDiagnostics?.selectedSymbol).toBe("AAPL260619C00145000");
    expect(spread?.optionSelectionDiagnostics?.spread).toMatchObject({
      sameExpirationContracts: 1,
      priceAndOpenInterestEligible: 1,
      strikeSideEligible: 0
    });
    expect(spread?.optionSelectionDiagnostics?.rejectionReasons.join(" ")).toMatch(/short leg/i);
  });
});

function makeBullishSnapshot(): SignalSnapshot {
  return {
    symbol: "AAPL",
    asOf: "2026-05-14T14:30:00.000Z",
    lastPrice: 140,
    previousClose: 138,
    sma20: 133,
    sma50: 125,
    sma200: 115,
    rsi14: 58,
    atr14: 4,
    volumeRatio: 1.3,
    recentHigh: 142,
    recentLow: 132,
    suggestedStop: 132,
    suggestedTarget: 156,
    riskReward: 2,
    trend: "uptrend",
    bias: "bullish",
    score: 82,
    positionSizeShares: 50,
    positionNotional: 7000,
    riskDollars: 400,
    notes: ["Price is stacked above key moving averages."],
    bars: []
  };
}

function makeBearishSnapshot(): SignalSnapshot {
  return {
    ...makeBullishSnapshot(),
    lastPrice: 140,
    sma20: 145,
    sma50: 150,
    sma200: 155,
    rsi14: 38,
    recentHigh: 148,
    recentLow: 135,
    suggestedStop: 148,
    suggestedTarget: 124,
    trend: "downtrend",
    bias: "bearish",
    score: 28,
    notes: ["Trend is down and rallies are failing."]
  };
}

function makeOptions(): OptionIdea[] {
  return [
    makeOption({ symbol: "AAPL260619C00145000", type: "call", strikePrice: 145, closePrice: 4.5, bidPrice: 4.4, askPrice: 4.6, openInterest: 500 }),
    makeOption({ symbol: "AAPL260619C00150000", type: "call", strikePrice: 150, closePrice: 2.3, bidPrice: 2.2, askPrice: 2.4, openInterest: 450 }),
    makeOption({ symbol: "AAPL260619P00135000", type: "put", strikePrice: 135, closePrice: 3.1, bidPrice: 3, askPrice: 3.2, openInterest: 400 }),
    makeOption({ symbol: "AAPL260619P00130000", type: "put", strikePrice: 130, closePrice: 1.5, bidPrice: 1.45, askPrice: 1.55, openInterest: 350 })
  ];
}

function makeOption(patch: Partial<OptionIdea> & Pick<OptionIdea, "symbol" | "type" | "strikePrice" | "closePrice">): OptionIdea {
  return {
    underlyingSymbol: "AAPL",
    expirationDate: "2026-06-19",
    openInterest: 250,
    breakeven: patch.type === "call"
      ? Number((patch.strikePrice + (patch.closePrice ?? 0)).toFixed(2))
      : Number((patch.strikePrice - (patch.closePrice ?? 0)).toFixed(2)),
    maxLoss: patch.closePrice ? patch.closePrice * 100 : null,
    liquidityWarning: null,
    ...patch
  };
}
