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
