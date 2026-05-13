import { describe, expect, it } from "vitest";
import { runBacktest } from "../server/backtest";
import { getDefaultRiskSettings } from "../server/storage";
import type { Bar, BacktestRequest } from "../src/shared/types";

describe("backtest engine", () => {
  it("runs a basic long-only swing backtest with benchmark comparison", () => {
    const bars = makeEntryFriendlyBars("2025-01-01", 320);
    const request = makeRequest({
      symbols: ["AAPL"],
      startDate: dateAt(bars, 240),
      endDate: dateAt(bars, 300),
      minScore: 65
    });

    const result = runBacktest({
      request,
      barsBySymbol: { AAPL: bars },
      benchmarkBars: makeTrendingBars("2025-01-01", 320, 400, 0.4),
      riskSettings: getDefaultRiskSettings(),
      now: new Date("2026-05-13T14:00:00.000Z")
    });

    expect(result.numberOfTrades).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.benchmarkReturnPct).not.toBeNull();
    expect(result.trades[0].entryDate >= request.startDate).toBe(true);
  });

  it("does not use future bars when ranking candidates", () => {
    const good = makeEntryFriendlyBars("2025-01-01", 330);
    const leak = makeFlatThenFutureSpikeBars("2025-01-01", 330);
    const request = makeRequest({
      symbols: ["GOOD", "LEAK"],
      startDate: dateAt(good, 240),
      endDate: dateAt(good, 270),
      minScore: 65
    });

    const result = runBacktest({
      request,
      barsBySymbol: { GOOD: good, LEAK: leak },
      benchmarkBars: good,
      riskSettings: getDefaultRiskSettings(),
      now: new Date("2026-05-13T14:00:00.000Z")
    });

    expect(result.trades.some((trade) => trade.symbol === "GOOD")).toBe(true);
    expect(result.trades.some((trade) => trade.symbol === "LEAK")).toBe(false);
  });
});

function makeRequest(patch: Partial<BacktestRequest>): BacktestRequest {
  return {
    symbols: ["AAPL"],
    startDate: "2025-09-01",
    endDate: "2025-12-01",
    holdingPeriodDays: 10,
    maxPositions: 2,
    minScore: 70,
    initialEquity: 100000,
    ...patch
  };
}

function makeTrendingBars(startDate: string, count: number, startPrice: number, slope: number): Bar[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const close = startPrice + index * slope;
    return {
      timestamp: date.toISOString(),
      open: close - 0.25,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 1000000 + index * 1000
    };
  });
}

function makeEntryFriendlyBars(startDate: string, count: number): Bar[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const pullback = index > 215 ? Math.min(index - 215, 20) * 0.8 : 0;
    const close = 100 + index * 0.45 - pullback;
    return {
      timestamp: date.toISOString(),
      open: close - 0.2,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 1000000 + index * 1000
    };
  });
}

function makeFlatThenFutureSpikeBars(startDate: string, count: number): Bar[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const close = index > 290 ? 100 + (index - 290) * 8 : 100;
    return {
      timestamp: date.toISOString(),
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000000
    };
  });
}

function dateAt(bars: Bar[], index: number): string {
  return bars[index].timestamp.slice(0, 10);
}
