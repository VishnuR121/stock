import { describe, expect, it } from "vitest";
import { getDefaultRiskProfile } from "../server/indicators";
import { validateMultiLegPaperOrder, validatePaperOrder } from "../server/validation";
import { getDefaultRiskSettings } from "../server/storage";

describe("paper order validation", () => {
  const riskProfile = getDefaultRiskProfile(100000);

  it("accepts a conservative long equity paper order", () => {
    const result = validatePaperOrder(
      {
        symbol: "SPY",
        orderType: "market",
        quantity: 10,
        stopLossPrice: 95,
        takeProfitPrice: 112,
        timeInForce: "gtc",
        horizon: "swing",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      },
      riskProfile,
      100
    );

    expect(result.ok).toBe(true);
    expect(result.estimatedNotional).toBe(1000);
    expect(result.estimatedRisk).toBe(50);
  });

  it("rejects option-like symbols and missing acknowledgements", () => {
    const result = validatePaperOrder(
      {
        symbol: "AAPL240119C00100000",
        orderType: "market",
        quantity: 1,
        stopLossPrice: 1,
        takeProfitPrice: 5,
        timeInForce: "day",
        earningsChecked: false,
        confirmedPaperOnly: false,
        acceptedRisk: false
      },
      riskProfile,
      3
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/equity or ETF/);
  });

  it("rejects oversized paper positions", () => {
    const result = validatePaperOrder(
      {
        symbol: "MSFT",
        orderType: "market",
        notional: 25000,
        stopLossPrice: 95,
        takeProfitPrice: 120,
        timeInForce: "gtc",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      },
      riskProfile,
      100
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/max notional/);
  });

  it("warns when risk reward is below the conservative floor", () => {
    const result = validatePaperOrder(
      {
        symbol: "QQQ",
        orderType: "market",
        quantity: 5,
        stopLossPrice: 95,
        takeProfitPrice: 102,
        timeInForce: "day",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      },
      riskProfile,
      100,
      { now: new Date("2026-05-13T14:00:00.000Z") }
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Risk\/reward/);
  });

  it("blocks unrealistic late-session DAY targets", () => {
    const result = validatePaperOrder(
      {
        symbol: "XLI",
        side: "buy",
        orderType: "market",
        quantity: 1,
        stopLossPrice: 99,
        takeProfitPrice: 105.3,
        timeInForce: "day",
        horizon: "intraday",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      },
      riskProfile,
      100,
      { now: new Date("2026-05-13T19:24:00.000Z") }
    );

    expect(result.ok).toBe(false);
    expect(result.targetRealism?.minutesUntilSessionClose).toBe(36);
    expect(result.errors.join(" ")).toMatch(/Target is \+5\.3% away with 36 minutes left/);
  });

  it("allows realistic intraday DAY targets", () => {
    const result = validatePaperOrder(
      {
        symbol: "XLI",
        side: "buy",
        orderType: "market",
        quantity: 10,
        stopLossPrice: 99.8,
        takeProfitPrice: 100.4,
        timeInForce: "day",
        horizon: "intraday",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      },
      riskProfile,
      100,
      { now: new Date("2026-05-13T19:24:00.000Z") }
    );

    expect(result.ok).toBe(true);
    expect(result.targetRealism?.targetDistancePct).toBe(0.4);
    expect(result.targetRealism?.severity).toBe("info");
  });

  it("accepts a conservative short equity paper order", () => {
    const result = validatePaperOrder(
      {
        symbol: "SPY",
        side: "sell",
        orderType: "market",
        quantity: 10,
        stopLossPrice: 105,
        takeProfitPrice: 90,
        timeInForce: "gtc",
        horizon: "swing",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      },
      riskProfile,
      100
    );

    expect(result.ok).toBe(true);
    expect(result.estimatedNotional).toBe(1000);
    expect(result.estimatedRisk).toBe(50);
  });

  it("validates long call paper simulation max loss and paper-only confirmations", () => {
    const result = validateMultiLegPaperOrder(
      makeOptionOrder({
        expressionType: "long_call",
        legs: [makeLeg({ optionSymbol: "AAPL260619C00145000", optionType: "call", side: "buy", strike: 145 })],
        estimatedDebit: 450,
        maxLoss: 450,
        breakeven: 149.5,
        requiredCapital: 450
      }),
      riskProfile,
      getDefaultRiskSettings(),
      { buyingPower: 100000, alpacaPaperOnly: true, now: new Date("2026-05-14T15:00:00Z") }
    );

    expect(result.ok).toBe(true);
    expect(result.estimatedRisk).toBe(450);
  });

  it("blocks naked calls and research-only multi-leg orders", () => {
    const result = validateMultiLegPaperOrder(
      makeOptionOrder({
        expressionType: "covered_call",
        legs: [makeLeg({ optionSymbol: "AAPL260619C00145000", optionType: "call", side: "sell", strike: 145 })],
        paperExecutionMode: "research_only",
        maxLoss: 1000,
        requiredCapital: 0
      }),
      riskProfile,
      getDefaultRiskSettings(),
      { buyingPower: 100000, alpacaPaperOnly: true, now: new Date("2026-05-14T15:00:00Z") }
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Research-only|Undefined-risk|naked/i);
  });

  it("blocks 0DTE options by default and warns on wide bid/ask spreads", () => {
    const result = validateMultiLegPaperOrder(
      makeOptionOrder({
        expressionType: "long_put",
        legs: [makeLeg({ optionSymbol: "AAPL260514P00135000", optionType: "put", side: "buy", strike: 135, expiration: "2026-05-14", bid: 1, ask: 1.5 })],
        estimatedDebit: 125,
        maxLoss: 125,
        breakeven: 133.75,
        requiredCapital: 125
      }),
      riskProfile,
      getDefaultRiskSettings(),
      { buyingPower: 100000, alpacaPaperOnly: true, now: new Date("2026-05-14T15:00:00Z") }
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/0DTE/);
    expect(result.warnings.join(" ")).toMatch(/wide bid\/ask/i);
  });

  it("blocks option paper orders when the kill switch or live endpoint is active", () => {
    const result = validateMultiLegPaperOrder(
      makeOptionOrder({
        expressionType: "bull_call_debit_spread",
        legs: [
          makeLeg({ optionSymbol: "AAPL260619C00145000", optionType: "call", side: "buy", strike: 145 }),
          makeLeg({ optionSymbol: "AAPL260619C00150000", optionType: "call", side: "sell", strike: 150 })
        ],
        estimatedDebit: 220,
        maxLoss: 220,
        maxProfit: 280,
        breakeven: 147.2,
        requiredCapital: 220
      }),
      riskProfile,
      { ...getDefaultRiskSettings(), killSwitchEnabled: true },
      { buyingPower: 100000, alpacaPaperOnly: false, now: new Date("2026-05-14T15:00:00Z") }
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/kill switch/);
    expect(result.errors.join(" ")).toMatch(/Live Alpaca/);
  });

  it("blocks options paper simulations that exceed open portfolio caps", () => {
    const result = validateMultiLegPaperOrder(
      makeOptionOrder({
        expressionType: "long_call",
        legs: [makeLeg({ optionSymbol: "AAPL260619C00145000", optionType: "call", side: "buy", strike: 145 })],
        estimatedDebit: 450,
        maxLoss: 450,
        requiredCapital: 450
      }),
      riskProfile,
      { ...getDefaultRiskSettings(), maxOpenPositions: 2, maxOptionsContracts: 4, maxStrategyExposurePct: 0.1 },
      {
        buyingPower: 100000,
        alpacaPaperOnly: true,
        now: new Date("2026-05-14T15:00:00Z"),
        openPaperPositionCount: 2,
        existingOptionsContracts: 4,
        existingUnderlyingRequiredCapital: 9900
      }
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/max open positions/i);
    expect(result.errors.join(" ")).toMatch(/max options contract/i);
    expect(result.errors.join(" ")).toMatch(/AAPL options exposure/i);
  });
});

function makeOptionOrder(patch: Record<string, unknown>) {
  return {
    expressionType: "long_call",
    underlyingSymbol: "AAPL",
    legs: [makeLeg({ optionSymbol: "AAPL260619C00145000", optionType: "call", side: "buy", strike: 145 })],
    estimatedDebit: 450,
    maxLoss: 450,
    requiredCapital: 450,
    paperExecutionMode: "internal_simulation",
    timeHorizon: "30-60 DTE swing options",
    earningsChecked: true,
    confirmedPaperOnly: true,
    acceptedRisk: true,
    maxLossAcknowledged: true,
    paperSimulationAcknowledged: true,
    noLiveEndpointAcknowledged: true,
    ...patch
  };
}

function makeLeg(patch: Record<string, unknown>) {
  return {
    optionSymbol: "AAPL260619C00145000",
    underlyingSymbol: "AAPL",
    optionType: "call",
    side: "buy",
    quantity: 1,
    strike: 145,
    expiration: "2026-06-19",
    limitPrice: 4.5,
    estimatedMid: 4.5,
    bid: 4.4,
    ask: 4.6,
    openInterest: 250,
    volume: 100,
    ...patch
  };
}
