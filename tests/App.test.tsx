import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { AlgoTradeProposal, DeterministicTradePlan, OpportunityScan, RiskSettings, SignalSnapshot, TradeJournalEntry } from "../src/shared/types";

describe("dashboard", () => {
  let watchlistPosts: string[];
  let backtestPosts: string[];
  let algoProposals: AlgoTradeProposal[];
  let riskSettings: RiskSettings;
  let riskSettingsPosts: RiskSettings[];
  let journalEntries: TradeJournalEntry[];

  beforeEach(() => {
    watchlistPosts = [];
    backtestPosts = [];
    algoProposals = makeAlgoProposals();
    riskSettingsPosts = [];
    riskSettings = {
      maxRiskPerTradePct: 0.01,
      maxPositionPct: 0.1,
      maxDailyLossPct: 0.03,
      minRiskReward: 1.5,
      maxDataAgeMinutes: 4320,
      priceCollarPct: 0.03,
      earningsWindowDays: 7,
      killSwitchEnabled: false
    };
    journalEntries = [
      {
        id: "journal-delete-test",
        symbol: "SPY",
        createdAt: "2026-05-12T12:00:00.000Z",
        updatedAt: "2026-05-12T12:00:00.000Z",
        status: "watching",
        action: "watch",
        notes: "Delete me"
      },
      {
        id: "journal-closed-test",
        symbol: "AAPL",
        createdAt: "2026-05-11T12:00:00.000Z",
        updatedAt: "2026-05-11T12:00:00.000Z",
        status: "paper_closed",
        action: "paper_long_candidate",
        notes: "Closed from plan.",
        entryPrice: 100,
        stopLossPrice: 95,
        takeProfitPrice: 110,
        exitPrice: 110,
        pnl: 10,
        outcome: "win",
        exitReason: "target"
      }
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/api/health")) {
        return jsonResponse({
          ok: true,
          alpacaConfigured: false,
          alpacaPaperOnly: true,
          paperTradingBlockedReasons: riskSettings.killSwitchEnabled
            ? ["Alpaca paper credentials are missing.", "Paper order kill switch is enabled."]
            : ["Alpaca paper credentials are missing."],
          killSwitchEnabled: riskSettings.killSwitchEnabled,
          aiProvider: "openai",
          aiConfigured: false,
          aiModel: "gpt-5.4-mini",
          openAiConfigured: false,
          openAiModel: "gpt-5.4-mini",
          anthropicConfigured: false,
          anthropicModel: "claude-sonnet-4-6",
          alphaVantageConfigured: false,
          secUserAgentConfigured: false,
          tradingViewWebhookConfigured: false,
          databaseConfigured: true,
          dataStore: "postgres"
        });
      }
      if (target.endsWith("/api/settings/risk")) {
        if (init?.method === "POST") {
          riskSettings = { ...riskSettings, ...JSON.parse(String(init.body ?? "{}")) };
          riskSettingsPosts.push(riskSettings);
        }
        return jsonResponse(riskSettings);
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
      if (target.endsWith("/api/backtest")) {
        backtestPosts.push(String(init?.body ?? ""));
        return jsonResponse(makeBacktestResult());
      }
      if (target.endsWith("/api/trade-plan/deterministic")) {
        return jsonResponse(makeQuantPlan());
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
      if (target.endsWith("/api/journal/analytics")) {
        return jsonResponse({
          totalPaperTrades: 2,
          openPaperTrades: 1,
          closedPaperTrades: 1,
          skippedTrades: 1,
          winRate: 100,
          averageR: 2,
          totalPnl: 250,
          followedPlanTrades: 1,
          planDeviationTrades: 1,
          followPlanRate: 50,
          bestTrade: { id: "best", symbol: "AAPL", pnl: 250, rMultiple: 2 },
          worstTrade: { id: "worst", symbol: "MSFT", pnl: -50, rMultiple: -1 },
          mostCommonSkippedReason: "Earnings too close",
          mostCommonExitReason: "stop"
        });
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

    expect((await screen.findAllByText("SPY")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Overview$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Research$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Trade Plan$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Backtests$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Orders$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Journal$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Settings$/i })).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(await screen.findByText("Market regime")).toBeInTheDocument();
    expect(screen.getByText("Bullish")).toBeInTheDocument();
    expect(screen.getByText("Research guardrails")).toBeInTheDocument();
    expect(screen.getByText("Paper only")).toBeInTheDocument();
    expect(screen.getAllByText("Run scan").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Research$/i }));
    expect(screen.getByText("Opportunity Finder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Trade Plan$/i }));
    expect(screen.getByText("Paper order")).toBeInTheDocument();
    expect(screen.getByText("No signal loaded")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Algo$/i }));
    expect(screen.getByText("Algo Command Center")).toBeInTheDocument();
  });

  it("runs a backtest and renders summary results", async () => {
    render(<App />);

    await screen.findAllByText("SPY");
    fireEvent.click(screen.getByRole("button", { name: /^Backtests$/i }));
    expect(screen.getByText("Long-only swing test using historical bars. Signals use only past data and enter on the next bar.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Bullish"));

    fireEvent.click(screen.getByRole("button", { name: /^Run backtest$/i }));

    expect(await screen.findByText("Backtest complete: 13 trades.")).toBeInTheDocument();
    expect(screen.getByText("Total return")).toBeInTheDocument();
    expect(screen.getByText("Near benchmark")).toBeInTheDocument();
    expect(screen.getByText("Strategy was +1.15% versus SPY.")).toBeInTheDocument();
    expect(screen.getByText("Vs SPY")).toBeInTheDocument();
    expect(screen.getByText("+1.15%")).toBeInTheDocument();
    expect(screen.getByText("Average win")).toBeInTheDocument();
    expect(screen.getByText("Profit factor")).toBeInTheDocument();
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("BT12")).toBeInTheDocument();
    expect(screen.getByText("13 total")).toBeInTheDocument();
    expect(screen.getByText("target")).toBeInTheDocument();
    expect(screen.getByText("Regime filter used SPY and QQQ history.")).toBeInTheDocument();
    expect(backtestPosts[0]).toContain('"marketRegimeFilter":["bullish"]');
  });

  it("loads an opportunity candidate and can add it to the watchlist", async () => {
    render(<App />);

    await screen.findAllByText("SPY");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Find opportunities$/i })).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^Find opportunities$/i }));

    expect(await screen.findByText("TSLA")).toBeInTheDocument();
    expect(screen.getByText("Buy setup")).toBeInTheDocument();
    expect(screen.getByText("Trend 90")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Analyze/i }));
    expect(await screen.findByText("TSLA loaded for analysis.")).toBeInTheDocument();
    expect(await screen.findByText("$248 - $252")).toBeInTheDocument();
    expect(screen.getByText("Max risk")).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole("button", { name: /^Journal$/i }));
    expect(await screen.findByText(/Delete me/)).toBeInTheDocument();
    expect(screen.getByText("Total paper")).toBeInTheDocument();
    expect(screen.getByText("Follow plan")).toBeInTheDocument();
    expect(screen.getByText("Exit: Target")).toBeInTheDocument();
    expect(screen.getByText("R: 2")).toBeInTheDocument();
    expect(screen.getByText("Common exit: Stop")).toBeInTheDocument();
    expect(screen.getByText("Common skip: Earnings too close")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Closed journal entries \(1\)/i }));
    expect(screen.queryByText(/Delete me/)).not.toBeInTheDocument();
    expect(screen.getByText("AAPL")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Watching journal entries \(1\)/i }));
    expect(screen.getByText(/Delete me/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Delete SPY journal entry/i }));
    await waitFor(() => expect(screen.queryByText(/Delete me/)).not.toBeInTheDocument());
  });

  it("saves edited risk settings from the settings workspace", async () => {
    render(<App />);

    await screen.findAllByText("SPY");
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));
    expect(await screen.findByText("Risk settings")).toBeInTheDocument();
    expect(screen.getByText("API + data status")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Max risk per trade %"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("Minimum R/R"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText("Kill switch enabled"));
    const saveButton = screen.getByRole("button", { name: /^Save risk settings$/i });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(riskSettingsPosts).toHaveLength(1));
    expect(riskSettingsPosts[0].maxRiskPerTradePct).toBe(0.005);
    expect(riskSettingsPosts[0].minRiskReward).toBe(2);
    expect(riskSettingsPosts[0].killSwitchEnabled).toBe(true);
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
        ranking: {
          symbol: "TSLA",
          rawScore: 82,
          adjustedScore: 88,
          rank: 1,
          action: "buy",
          bias: "bullish",
          reasons: ["Trend component: 90/100."],
          warnings: [],
          suggestedStop: 198,
          suggestedTarget: 234,
          riskReward: 2,
          components: {
            trendScore: 90,
            momentumScore: 85,
            riskRewardScore: 78,
            volumeScore: 72,
            volatilityScore: 82,
            rsiQualityScore: 88,
            marketRegimeAdjustment: 6
          }
        },
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

function makeQuantPlan(): DeterministicTradePlan {
  const snapshot = makeSnapshot();
  return {
    symbol: snapshot.symbol,
    generatedAt: "2026-05-13T14:00:00.000Z",
    currentPrice: snapshot.lastPrice,
    marketRegime: {
      regime: "bullish",
      score: 78,
      explanation: "Broad-market trend is supportive.",
      riskAdjustmentMultiplier: 1,
      warnings: [],
      generatedAt: "2026-05-13T14:00:00.000Z",
      components: []
    },
    bias: "bullish",
    action: "paper_long_candidate",
    entryZone: { low: 248, high: 252 },
    stopLoss: snapshot.suggestedStop,
    conservativeTarget: snapshot.suggestedTarget,
    aggressiveTarget: 244,
    riskReward: snapshot.riskReward,
    positionSizeShares: snapshot.positionSizeShares,
    positionNotional: snapshot.positionNotional,
    maxRiskDollars: snapshot.riskDollars,
    invalidationCondition: "Close below 198 invalidates the setup.",
    timeHorizon: "Swing trade: several days to a few weeks, reviewed daily.",
    keyReasons: ["Trend component: 90/100."],
    keyRisks: ["This is paper-trading research, not financial advice."],
    warnings: [],
    ranking: {
      symbol: snapshot.symbol,
      rawScore: 82,
      adjustedScore: 88,
      rank: 1,
      action: "buy",
      bias: "bullish",
      reasons: ["Trend component: 90/100."],
      warnings: [],
      suggestedStop: snapshot.suggestedStop,
      suggestedTarget: snapshot.suggestedTarget,
      riskReward: snapshot.riskReward,
      components: {
        trendScore: 90,
        momentumScore: 85,
        riskRewardScore: 78,
        volumeScore: 72,
        volatilityScore: 82,
        rsiQualityScore: 88,
        marketRegimeAdjustment: 6
      }
    }
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
    warnings: ["Regime filter used SPY and QQQ history."],
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

function makeBacktestResult() {
  const trades = [
    {
      id: "bt-aapl",
      symbol: "AAPL",
      side: "long",
      entryDate: "2025-03-01",
      exitDate: "2025-03-10",
      entryPrice: 100,
      exitPrice: 108.5,
      quantity: 50,
      stopLossPrice: 95,
      targetPrice: 108.5,
      entryScore: 82,
      exitReason: "target",
      pnl: 425,
      pnlPct: 8.5,
      rMultiple: 1.7,
      riskDollars: 250
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `bt-extra-${index + 1}`,
      symbol: `BT${index + 1}`,
      side: "long",
      entryDate: "2025-04-01",
      exitDate: "2025-04-08",
      entryPrice: 100 + index,
      exitPrice: 101 + index,
      quantity: 10,
      stopLossPrice: 95 + index,
      targetPrice: 110 + index,
      entryScore: 75,
      exitReason: "holding_period",
      pnl: 10,
      pnlPct: 1,
      rMultiple: 0.2,
      riskDollars: 50
    }))
  ];

  return {
    generatedAt: "2026-05-13T14:00:00.000Z",
    request: {
      symbols: ["AAPL"],
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      holdingPeriodDays: 10,
      maxPositions: 3,
      minScore: 70,
      initialEquity: 100000
    },
    totalReturnPct: 4.25,
    annualizedReturnPct: 4.4,
    winRate: 100,
    averageWin: 425,
    averageLoss: 0,
    maxDrawdownPct: -1.2,
    numberOfTrades: trades.length,
    profitFactor: null,
    benchmarkReturnPct: 3.1,
    warnings: ["Regime filter used SPY and QQQ history."],
    equityCurve: [
      {
        date: "2025-12-30",
        equity: 104000,
        benchmarkEquity: 103000,
        drawdownPct: -0.2
      },
      {
        date: "2025-12-31",
        equity: 104250,
        benchmarkEquity: 103100,
        drawdownPct: 0
      }
    ],
    trades
  };
}
