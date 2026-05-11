import { describe, expect, it } from "vitest";
import { atr, buildSignalSnapshot, getDefaultRiskProfile, rsi, sma } from "../server/indicators";
import type { Bar } from "../src/shared/types";

describe("technical indicators", () => {
  it("calculates moving averages, RSI, and ATR", () => {
    const bars = makeBars(60);
    const closes = bars.map((bar) => bar.close);

    expect(sma(closes, 20)).toBeGreaterThan(120);
    expect(rsi(closes, 14)).toBeGreaterThan(70);
    expect(atr(bars, 14)).toBeGreaterThan(1);
  });

  it("builds a conservative swing snapshot", () => {
    const bars = makeBars(260);
    const snapshot = buildSignalSnapshot("AAPL", bars, getDefaultRiskProfile(100000));

    expect(snapshot.symbol).toBe("AAPL");
    expect(snapshot.trend).toBe("uptrend");
    expect(snapshot.suggestedStop).toBeLessThan(snapshot.lastPrice as number);
    expect(snapshot.suggestedTarget).toBeGreaterThan(snapshot.lastPrice as number);
    expect(snapshot.positionSizeShares).toBeGreaterThan(0);
    expect(snapshot.positionNotional).toBeLessThanOrEqual(10000);
  });
});

function makeBars(count: number): Bar[] {
  const start = new Date("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.55;
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      timestamp: date.toISOString(),
      open: close - 0.25,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 900000 + index * 3000
    };
  });
}
