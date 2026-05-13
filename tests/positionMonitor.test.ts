import { describe, expect, it } from "vitest";
import { buildPositionMonitorSnapshot } from "../server/positionMonitor";
import type { AlgoTradeProposal } from "../src/shared/types";

describe("position monitor", () => {
  it("suggests closing options at profit target", () => {
    const monitor = buildPositionMonitorSnapshot({
      now: new Date("2028-05-01T14:00:00.000Z"),
      openOrders: [],
      proposals: [makeOptionProposal()],
      positions: [
        {
          symbol: "XLI280515C00175000",
          asset_class: "us_option",
          side: "long",
          qty: "1",
          avg_entry_price: "1.86",
          current_price: "2.90",
          market_value: "290",
          unrealized_pl: "104",
          unrealized_plpc: "0.5591",
          cost_basis: "186"
        }
      ]
    });

    expect(monitor.summary.exitsSuggested).toBe(1);
    expect(monitor.positions[0].urgency).toBe("exit");
    expect(monitor.positions[0].daysToExpiration).toBe(15);
    expect(monitor.positions[0].reasons.join(" ")).toMatch(/take-profit/);
  });

  it("flags unmatched positions for manual review", () => {
    const monitor = buildPositionMonitorSnapshot({
      openOrders: [],
      proposals: [],
      positions: [
        {
          symbol: "SPY",
          side: "long",
          qty: "5",
          avg_entry_price: "500",
          current_price: "502",
          unrealized_pl: "10",
          unrealized_plpc: "0.004"
        }
      ]
    });

    expect(monitor.positions[0].urgency).toBe("watch");
    expect(monitor.positions[0].suggestedAction).toMatch(/Review/);
  });
});

function makeOptionProposal(): AlgoTradeProposal {
  return {
    id: "algo-xli-option",
    createdAt: "2028-04-30T14:00:00.000Z",
    updatedAt: "2028-04-30T14:00:00.000Z",
    symbol: "XLI",
    sourceAnalysisId: "analysis-xli",
    signalAsOf: "2028-04-30T14:00:00.000Z",
    strategyKind: "long_call",
    strategyTitle: "Long call",
    direction: "bullish",
    status: "placed",
    executionType: "long_option",
    horizon: "options_short_term",
    expectedHoldingPeriod: "Short-term option entry; exits managed by Position Monitor",
    executable: true,
    score: 95,
    summary: "Bullish call.",
    setup: [],
    riskNotes: [],
    warnings: [],
    optionOrder: {
      contractSymbol: "XLI280515C00175000",
      underlyingSymbol: "XLI",
      optionType: "call",
      orderType: "limit",
      quantity: 1,
      limitPrice: 1.86,
      timeInForce: "day",
      horizon: "options_short_term",
      estimatedPremium: 1.86,
      estimatedMaxLoss: 186,
      earningsChecked: true,
      confirmedPaperOnly: true,
      acceptedRisk: true
    }
  };
}
