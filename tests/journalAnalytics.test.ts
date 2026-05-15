import { describe, expect, it } from "vitest";
import { buildJournalAnalytics } from "../server/journalAnalytics";
import type { TradeJournalEntry } from "../src/shared/types";

describe("journal analytics", () => {
  it("summarizes paper trade outcomes and estimated R multiples", () => {
    const analytics = buildJournalAnalytics([
      makeEntry({ id: "win", symbol: "AAPL", status: "paper_closed", pnl: 300, entryPrice: 100, stopLossPrice: 95, outcome: "win" }),
      makeEntry({ id: "loss", symbol: "MSFT", status: "paper_closed", pnl: -150, entryPrice: 50, stopLossPrice: 47, outcome: "loss", followedPlan: false, exitReason: "stop" }),
      makeEntry({ id: "open", symbol: "SPY", status: "paper_open", followedPlan: true }),
      makeEntry({ id: "skip", symbol: "QQQ", status: "skipped", notes: "Earnings too close" })
    ]);

    expect(analytics.totalPaperTrades).toBe(3);
    expect(analytics.closedPaperTrades).toBe(2);
    expect(analytics.openPaperTrades).toBe(1);
    expect(analytics.winRate).toBe(50);
    expect(analytics.averageR).toBe(5);
    expect(analytics.totalPnl).toBe(150);
    expect(analytics.followedPlanTrades).toBe(1);
    expect(analytics.planDeviationTrades).toBe(1);
    expect(analytics.followPlanRate).toBe(50);
    expect(analytics.bestTrade?.symbol).toBe("AAPL");
    expect(analytics.worstTrade?.symbol).toBe("MSFT");
    expect(analytics.mostCommonSkippedReason).toBe("Earnings too close");
    expect(analytics.mostCommonExitReason).toBe("stop");
  });

  it("summarizes performance by expression type and options DTE", () => {
    const analytics = buildJournalAnalytics([
      makeEntry({
        id: "call",
        symbol: "AAPL",
        status: "paper_closed",
        action: "paper_options_candidate",
        expressionType: "long_call",
        assetClass: "option",
        optionLegs: [{
          optionSymbol: "AAPL260619C00145000",
          underlyingSymbol: "AAPL",
          optionType: "call",
          side: "buy",
          quantity: 1,
          strike: 145,
          expiration: "2026-06-19"
        }],
        pnl: 120,
        realizedPnL: 120,
        actualRMultiple: 0.4,
        outcome: "win"
      }),
      makeEntry({
        id: "spread",
        symbol: "MSFT",
        status: "paper_closed",
        action: "paper_options_candidate",
        expressionType: "bull_call_debit_spread",
        assetClass: "multi_leg_option",
        optionLegs: [
          {
            optionSymbol: "MSFT260619C00400000",
            underlyingSymbol: "MSFT",
            optionType: "call",
            side: "buy",
            quantity: 1,
            strike: 400,
            expiration: "2026-06-19"
          },
          {
            optionSymbol: "MSFT260619C00410000",
            underlyingSymbol: "MSFT",
            optionType: "call",
            side: "sell",
            quantity: 1,
            strike: 410,
            expiration: "2026-06-19"
          }
        ],
        optionsMetadata: {
          assignmentRiskEvent: true,
          assignmentRiskReasons: ["Short call assignment risk was flagged near exit."]
        },
        pnl: -80,
        actualRMultiple: -0.5,
        outcome: "loss"
      })
    ]);

    expect(analytics.performanceByExpressionType.map((stat) => stat.key)).toContain("long_call");
    expect(analytics.averageRByExpressionType.find((stat) => stat.key === "long_call")?.averageR).toBe(0.4);
    expect(analytics.optionsMetrics.averageDteAtEntry).toBe(38);
    expect(analytics.optionsMetrics.performanceByStructure.map((stat) => stat.key)).toContain("spread");
    expect(analytics.optionsMetrics.assignmentRiskEvents).toBe(1);
  });
});

function makeEntry(patch: Partial<TradeJournalEntry>): TradeJournalEntry {
  return {
    id: "entry",
    symbol: "SPY",
    createdAt: "2026-05-13T14:00:00.000Z",
    updatedAt: "2026-05-13T14:00:00.000Z",
    status: "watching",
    action: "watch",
    notes: "",
    ...patch
  };
}
