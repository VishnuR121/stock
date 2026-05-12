import { describe, expect, it } from "vitest";
import { getDefaultRiskProfile } from "../server/indicators";
import { validatePaperOrder } from "../server/validation";

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
        timeInForce: "day",
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
      100
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/Risk\/reward/);
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
        timeInForce: "day",
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
});
