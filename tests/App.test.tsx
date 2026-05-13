import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { AlgoTradeProposal, OpportunityScan, SignalSnapshot } from "../src/shared/types";

describe("dashboard", () => {
  let watchlistPosts: string[];
  let algoProposals: AlgoTradeProposal[];
  let journalEntries: Array<{
    id: string;
    symbol: string;
    createdAt: string;
    updatedAt: string;
    status: "watching";
    action: "watch";
    notes: string;
  }>;

  beforeEach(() => {
    watchlistPosts = [];
    algoProposals = makeAlgoProposals();
    journalEntries = [
      {
        id: "journal-delete-test",
        symbol: "SPY",
        createdAt: "2026-05-12T12:00:00.000Z",
        updatedAt: "2026-05-12T12:00:00.000Z",
        status: "watching",
        action: "watch",
        notes: "Delete me"
      }
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/api/health")) {
        return jsonResponse({
          ok: true,
          alpacaConfigured: false,
          alpacaPaperOnly: true,
          aiProvider: "openai",
          aiConfigured: false,
          aiModel: "gpt-5.4-mini",
          openAiConfigured: false,
          openAiModel: "gpt-5.4-mini",
          anthropicConfigured: false,
          anthropicModel: "claude-sonnet-4-6",
          alphaVantageConfigured: false,
          databaseConfigured: false,
          dataStore: "data/app-data.json"
        });
      }
      if (target.endsWith("/api/watchlist")) {
        if (init?.method === "POST") {
          watchlistPosts.push(String(init.body ?? ""));
        }
        return jsonResponse([
          { symbol: "SPY", tags: ["ETF"], createdAt: "2026-01-01T00:00:00.000Z" }
        ]);
      }
      if (target.endsWith("/api/opportunities/scan")) {
        return jsonResponse({ scan: makeOpportunityScan(), cached: false });
      }
      if (target.endsWith("/api/market/regime")) {
        return jsonResponse({
          regime: "bullish",
          score: 78,
          explanation: "Broad-market trend is supportive.",
          riskAdjustmentMultiplier: 1,
          warnings: [],
          generatedAt: "2026-05-13T14:00:00.000Z",
          components: []
        });
      }
      if (target.endsWith("/api/algo/proposals")) {
        return jsonResponse(algoProposals);
      }
      if (target.includes("/api/algo/proposals/") && init?.method === "DELETE") {
        const id = target.split("/api/algo/proposals/")[1];
        algoProposals = algoProposals.filter((proposal) => proposal.id !== id);
        return jsonResponse({ id });
      }
      if (target.endsWith("/api/journal")) {
        return jsonResponse(journalEntries);
      }
      if (target.includes("/api/journal/") && init?.method === "DELETE") {
        const id = target.split("/api/journal/")[1];
        journalEntries = journalEntries.filter((entry) => entry.id !== id);
        return jsonResponse({ id });
      }
      return jsonResponse({ error: "offline" }, 503);
    });
  });

  it("renders the operating dashboard", async () => {
    render(<App />);

    expect(await screen.findByText("Research Copilot")).toBeInTheDocument();
    expect((await screen.findAllByText("SPY")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Overview$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Research$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Orders$/i })).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(await screen.findByText("Market regime")).toBeInTheDocument();
    expect(screen.getByText("Bullish")).toBeInTheDocument();
    expect(screen.getAllByText("Run scan").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Research$/i }));
    expect(screen.getByText("Opportunity Finder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Algo$/i }));
    expect(screen.getByText("Algo Command Center")).toBeInTheDocument();
  });

  it("loads an opportunity candidate and can add it to the watchlist", async () => {
    render(<App />);

    await screen.findAllByText("SPY");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Find opportunities$/i })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^Find opportunities$/i }));

    expect(await screen.findByText("TSLA")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Analyze/i }));
    expect(await screen.findByText("TSLA loaded for analysis.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    await waitFor(() => expect(watchlistPosts[0]).toContain("TSLA"));
  });

  it("shows the full saved algo proposal queue instead of truncating to four cards", async () => {
    render(<App />);

    await screen.findAllByText("SPY");
    fireEvent.click(screen.getByRole("button", { name: /^Algo$/i }));

    expect(await screen.findByText("6 saved")).toBeInTheDocument();
    expect(screen.getByText("4 queued")).toBeInTheDocument();
    expect(screen.getByText("4 shown")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All$/i }));
    expect(screen.getByText("6 shown")).toBeInTheDocument();
    expect(screen.getByText("XLI breakout 5")).toBeInTheDocument();
  });

  it("can delete algo proposals and journal entries from the dashboard", async () => {
    render(<App />);

    await screen.findAllByText("SPY");
    fireEvent.click(screen.getByRole("button", { name: /^Algo$/i }));
    expect(await screen.findByText("XLI breakout 0")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Delete XLI breakout 0 Long stock proposal/i }));
    await waitFor(() => expect(screen.queryByText("XLI breakout 0")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Account$/i }));
    expect(await screen.findByText(/Delete me/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Delete SPY journal entry/i }));
    await waitFor(() => expect(screen.queryByText(/Delete me/)).not.toBeInTheDocument());
  });
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    })
  );
}

function makeOpportunityScan(): OpportunityScan {
  const snapshot = makeSnapshot();
  return {
    id: "opportunity-test",
    createdAt: "2026-05-12T12:00:00.000Z",
    dateKey: "2026-05-12",
    universe: ["TSLA"],
    skipped: [],
    candidates: [
      {
        symbol: "TSLA",
        rank: 1,
        category: "bullish_long",
        direction: "bullish",
        opportunityScore: 88,
        riskAdjustedScore: 82,
        setupScore: 80,
        lastPrice: 210,
        riskReward: 2,
        upsidePct: 0.08,
        atrPct: 0.03,
        volumeRatio: 1.2,
        trend: "uptrend",
        bias: "bullish",
        reason: "Bullish trend setup with 2:1 risk/reward and 8% target room.",
        warnings: [],
        snapshot
      }
    ]
  };
}

function makeSnapshot(): SignalSnapshot {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date(Date.now() - (40 - index) * 86400000).toISOString(),
    open: 190 + index,
    high: 192 + index,
    low: 188 + index,
    close: 191 + index,
    volume: 1000000
  }));
  return {
    symbol: "TSLA",
    asOf: "2026-05-12T12:00:00.000Z",
    lastPrice: 210,
    previousClose: 208,
    sma20: 200,
    sma50: 190,
    sma200: 170,
    rsi14: 59,
    atr14: 6,
    volumeRatio: 1.2,
    recentHigh: 214,
    recentLow: 198,
    suggestedStop: 198,
    suggestedTarget: 234,
    riskReward: 2,
    trend: "uptrend",
    bias: "bullish",
    score: 80,
    positionSizeShares: 40,
    positionNotional: 8400,
    riskDollars: 480,
    notes: [],
    bars
  };
}

function makeAlgoProposals(): AlgoTradeProposal[] {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `algo-${index}`,
    createdAt: `2026-05-12T12:0${index}:00.000Z`,
    updatedAt: `2026-05-12T12:1${index}:00.000Z`,
    symbol: `XLI breakout ${index}`,
    sourceAnalysisId: `analysis-${index}`,
    signalAsOf: "2026-05-12T12:00:00.000Z",
    strategyKind: "long_stock",
    strategyTitle: "Long stock",
    direction: "bullish",
    status: index < 4 ? "queued" : "placed",
    executionType: "long_stock_bracket",
    horizon: "intraday",
    expectedHoldingPeriod: "Same trading session",
    executable: true,
    score: 90 - index,
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
    }
  }));
}
