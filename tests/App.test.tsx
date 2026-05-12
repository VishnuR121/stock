import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { OpportunityScan, SignalSnapshot } from "../src/shared/types";

describe("dashboard", () => {
  let watchlistPosts: string[];

  beforeEach(() => {
    watchlistPosts = [];
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
      return jsonResponse({ error: "offline" }, 503);
    });
  });

  it("renders the operating dashboard", async () => {
    render(<App />);

    expect(await screen.findByText("Research Copilot")).toBeInTheDocument();
    expect((await screen.findAllByText("SPY")).length).toBeGreaterThan(0);
    expect(screen.getByText("Run scan")).toBeInTheDocument();
    expect(screen.getByText("Opportunity Finder")).toBeInTheDocument();
  });

  it("loads an opportunity candidate and can add it to the watchlist", async () => {
    render(<App />);

    fireEvent.click(await screen.findByText("Find opportunities"));

    expect(await screen.findByText("TSLA")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Analyze/i }));
    expect(await screen.findByText("TSLA loaded for analysis.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));
    await waitFor(() => expect(watchlistPosts[0]).toContain("TSLA"));
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
