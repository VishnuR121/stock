import { describe, expect, it } from "vitest";
import { buildSimulatedOptionsSnapshot } from "../server/optionsSimulation";
import type { OptionIdea, OptionLeg, TradeJournalEntry } from "../src/shared/types";

describe("options simulation monitor", () => {
  it("marks open option simulations to market with current quotes", () => {
    const snapshot = buildSimulatedOptionsSnapshot({
      now: new Date("2026-05-14T15:00:00.000Z"),
      journal: [entry({
        maxLoss: 450,
        optionsMetadata: { estimatedDebit: 450 }
      })],
      optionsByUnderlying: {
        AAPL: [idea({ midPrice: 6 })]
      }
    });

    expect(snapshot.positions[0]).toMatchObject({
      currentValue: 600,
      entryValue: 450,
      unrealizedPnL: 150,
      quoteStatus: "live_quote",
      exitUrgency: "hold"
    });
    expect(snapshot.exposure.totalMaxLoss).toBe(450);
    expect(snapshot.exposure.totalUnrealizedPnL).toBe(150);
  });

  it("suggests exit when a defined-risk spread captures most max profit", () => {
    const snapshot = buildSimulatedOptionsSnapshot({
      now: new Date("2026-05-14T15:00:00.000Z"),
      journal: [entry({
        expressionType: "bull_call_debit_spread",
        maxLoss: 200,
        maxProfit: 300,
        optionLegs: [
          leg({ optionSymbol: "AAPL260619C00145000", side: "buy", strike: 145, estimatedMid: 4 }),
          leg({ optionSymbol: "AAPL260619C00150000", side: "sell", strike: 150, estimatedMid: 2 })
        ],
        optionsMetadata: { estimatedDebit: 200 }
      })],
      optionsByUnderlying: {
        AAPL: [
          idea({ symbol: "AAPL260619C00145000", midPrice: 6 }),
          idea({ symbol: "AAPL260619C00150000", midPrice: 1.5, strikePrice: 150 })
        ]
      }
    });

    expect(snapshot.positions[0].unrealizedPnL).toBe(250);
    expect(snapshot.positions[0].exitUrgency).toBe("exit");
    expect(snapshot.positions[0].exitReasons.join(" ")).toMatch(/max profit/i);
  });

  it("warns when current quotes are missing and uses entry estimates", () => {
    const snapshot = buildSimulatedOptionsSnapshot({
      now: new Date("2026-05-14T15:00:00.000Z"),
      journal: [entry({
        maxLoss: 450,
        optionsMetadata: { estimatedDebit: 450 }
      })],
      optionsByUnderlying: {}
    });

    expect(snapshot.positions[0]).toMatchObject({
      currentValue: 450,
      quoteStatus: "entry_estimate",
      exitUrgency: "watch"
    });
    expect(snapshot.positions[0].warnings.join(" ")).toMatch(/missing a current quote/i);
  });
});

function entry(patch: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  return {
    id: "journal-1",
    symbol: "AAPL",
    createdAt: "2026-05-14T14:00:00.000Z",
    updatedAt: "2026-05-14T14:00:00.000Z",
    status: "paper_open",
    action: "paper_options_candidate",
    notes: "Internal simulation.",
    outcome: "open",
    expressionType: "long_call",
    underlyingSymbol: "AAPL",
    assetClass: "option",
    optionLegs: [leg()],
    requiredCapital: 450,
    paperExecutionMode: "internal_simulation",
    ...patch
  };
}

function leg(patch: Partial<OptionLeg> = {}): OptionLeg {
  return {
    optionSymbol: "AAPL260619C00145000",
    underlyingSymbol: "AAPL",
    optionType: "call" as const,
    side: "buy" as const,
    quantity: 1,
    strike: 145,
    expiration: "2026-06-19",
    estimatedMid: 4.5,
    ...patch
  };
}

function idea(patch: Partial<OptionIdea> = {}): OptionIdea {
  return {
    symbol: "AAPL260619C00145000",
    underlyingSymbol: "AAPL",
    type: "call",
    expirationDate: "2026-06-19",
    strikePrice: 145,
    closePrice: 5,
    bidPrice: 5.9,
    askPrice: 6.1,
    midPrice: null,
    lastPrice: null,
    volume: 100,
    openInterest: 250,
    breakeven: 151,
    maxLoss: 600,
    daysToExpiration: 36,
    liquidityWarning: null,
    ...patch
  };
}
