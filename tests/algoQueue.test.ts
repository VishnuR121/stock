// @vitest-environment node
import { describe, expect, it } from "vitest";
import { JsonStore } from "../server/storage";
import type { AlgoTradeProposal } from "../src/shared/types";

describe("algo proposal queue persistence", () => {
  it("replaces duplicate active proposals while preserving placed history", async () => {
    const store = new JsonStore(`data/test-algo-queue-${Date.now()}.json`);
    const first = makeProposal({ id: "first", status: "queued", score: 70 });
    const replacement = makeProposal({ id: "replacement", status: "queued", score: 85 });
    const placed = makeProposal({ id: "placed", status: "placed", score: 65 });

    await store.saveAlgoTradeProposals([first, placed]);
    await store.saveAlgoTradeProposals([replacement]);

    const proposals = await store.getAlgoTradeProposals(10);
    expect(proposals.map((proposal) => proposal.id)).toEqual(["replacement", "placed"]);
    expect(proposals[0].score).toBe(85);
  });

  it("permanently deletes proposals and journal entries from JSON storage", async () => {
    const store = new JsonStore(`data/test-delete-records-${Date.now()}.json`);
    const proposal = makeProposal({ id: "delete-me", status: "queued" });
    const journal = await store.addJournalEntry({
      symbol: "XLI",
      status: "watching",
      action: "watch",
      notes: "delete test"
    });

    await store.saveAlgoTradeProposals([proposal]);
    await store.deleteAlgoTradeProposal(proposal.id);
    await store.deleteJournalEntry(journal.id);

    expect(await store.getAlgoTradeProposals(10)).toEqual([]);
    expect(await store.getJournal()).toEqual([]);
  });
});

function makeProposal(overrides: Partial<AlgoTradeProposal>): AlgoTradeProposal {
  return {
    id: overrides.id ?? "proposal",
    createdAt: "2026-05-12T12:00:00.000Z",
    updatedAt: "2026-05-12T12:00:00.000Z",
    symbol: "XLI",
    sourceAnalysisId: "analysis-xli",
    signalAsOf: "2026-05-12T12:00:00.000Z",
    strategyKind: "long_stock",
    strategyTitle: "Long stock",
    direction: "bullish",
    status: overrides.status ?? "queued",
    executionType: "long_stock_bracket",
    horizon: "intraday",
    expectedHoldingPeriod: "Same trading session",
    executable: true,
    score: overrides.score ?? 80,
    summary: "Test proposal",
    setup: [],
    riskNotes: [],
    warnings: [],
    order: {
      symbol: "XLI",
      side: "buy",
      orderType: "market",
      quantity: 10,
      stopLossPrice: 90,
      takeProfitPrice: 100,
      timeInForce: "day",
      horizon: "intraday",
      earningsChecked: true,
      confirmedPaperOnly: true,
      acceptedRisk: true
    },
    ...overrides
  };
}
