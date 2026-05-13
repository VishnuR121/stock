import { describe, expect, it } from "vitest";
import { buildMarketRegimeSnapshot } from "../server/marketRegime";
import type { Bar } from "../src/shared/types";

describe("market regime classifier", () => {
  it("classifies broad uptrends as bullish with normal risk", () => {
    const snapshot = buildMarketRegimeSnapshot({
      spyBars: makeBars({ slope: 0.8 }),
      qqqBars: makeBars({ slope: 1.1 }),
      now: new Date("2026-05-13T14:00:00.000Z")
    });

    expect(snapshot.regime).toBe("bullish");
    expect(snapshot.score).toBeGreaterThanOrEqual(70);
    expect(snapshot.riskAdjustmentMultiplier).toBe(1);
    expect(snapshot.components).toHaveLength(2);
  });

  it("classifies broad downtrends as bearish with reduced risk", () => {
    const snapshot = buildMarketRegimeSnapshot({
      spyBars: makeBars({ start: 320, slope: -0.7 }),
      qqqBars: makeBars({ start: 380, slope: -0.9 }),
      now: new Date("2026-05-13T14:00:00.000Z")
    });

    expect(snapshot.regime).toBe("bearish");
    expect(snapshot.score).toBeLessThanOrEqual(42);
    expect(snapshot.riskAdjustmentMultiplier).toBe(0.25);
    expect(snapshot.warnings.join(" ")).toMatch(/avoid weak long setups/i);
  });

  it("uses caution when trend is positive but volatility or drawdown is elevated", () => {
    const snapshot = buildMarketRegimeSnapshot({
      spyBars: makeBars({ slope: 0.55, shockStart: 246, shockSize: 22 }),
      qqqBars: makeBars({ slope: 0.65, shockStart: 246, shockSize: 26 }),
      now: new Date("2026-05-13T14:00:00.000Z")
    });

    expect(snapshot.regime).toBe("caution");
    expect(snapshot.riskAdjustmentMultiplier).toBe(0.5);
    expect(snapshot.warnings.join(" ")).toMatch(/stronger setups|smaller sizing/i);
  });
});

function makeBars(input: { start?: number; slope: number; shockStart?: number; shockSize?: number }): Bar[] {
  const startDate = new Date("2025-01-01T00:00:00.000Z");
  const start = input.start ?? 100;
  return Array.from({ length: 260 }, (_, index) => {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    const shock = input.shockStart !== undefined && index >= input.shockStart ? input.shockSize ?? 0 : 0;
    const close = start + index * input.slope - shock;
    const range = input.shockStart !== undefined && index >= input.shockStart ? 4 : 1.2;
    return {
      timestamp: date.toISOString(),
      open: close - range * 0.25,
      high: close + range,
      low: close - range,
      close,
      volume: 1000000 + index * 1000
    };
  });
}
