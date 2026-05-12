// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicTradePlanner } from "../server/anthropic";
import type { SignalSnapshot, TradeContext, TradePlan } from "../src/shared/types";

describe("AnthropicTradePlanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Claude tool output for structured trade plans", async () => {
    const plan = makePlan();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        content: [
          {
            type: "tool_use",
            name: "emit_trade_plan",
            input: plan
          }
        ]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const planner = new AnthropicTradePlanner({
      port: 3001,
      alpacaPaperBaseUrl: "https://paper-api.alpaca.markets",
      aiProvider: "anthropic",
      openAiModel: "gpt-5.4-mini",
      anthropicApiKey: "test-key",
      anthropicModel: "claude-test",
      secUserAgent: "test",
      dataFilePath: "data/test.json"
    });

    await expect(planner.createTradePlan(makeSnapshot(), makeContext())).resolves.toEqual(plan);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01"
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-test",
      tool_choice: { type: "tool", name: "emit_trade_plan" }
    });
  });
});

function makePlan(): TradePlan {
  return {
    symbol: "AAPL",
    action: "watch",
    bias: "neutral",
    beginnerSummary: "Watch only.",
    summary: "No clean setup.",
    thesis: ["Range-bound setup.", "Wait for confirmation."],
    invalidation: "Breakdown.",
    entryRequirements: ["Fresh scan.", "Confirm risk."],
    entryNotes: ["Paper only."],
    doNotTradeIf: ["Earnings soon.", "Risk/reward weak."],
    riskNotes: ["Use small size.", "No guarantees."],
    optionsNotes: ["Research only."],
    actionChecklist: ["Check earnings.", "Confirm paper only.", "Accept risk."],
    confidence: "low",
    warnings: ["Research only."]
  };
}

function makeSnapshot(): SignalSnapshot {
  return {
    symbol: "AAPL",
    asOf: new Date().toISOString(),
    lastPrice: 100,
    previousClose: 99,
    sma20: 98,
    sma50: 96,
    sma200: 90,
    rsi14: 55,
    atr14: 2,
    volumeRatio: 1,
    recentHigh: 102,
    recentLow: 95,
    suggestedStop: 95,
    suggestedTarget: 110,
    riskReward: 2,
    trend: "uptrend",
    bias: "bullish",
    score: 80,
    positionSizeShares: 10,
    positionNotional: 1000,
    riskDollars: 50,
    notes: [],
    bars: []
  };
}

function makeContext(): TradeContext {
  return {
    symbol: "AAPL",
    generatedAt: new Date().toISOString(),
    providers: { alpaca: "ok", alphaVantage: "missing_key", sec: "not_found" },
    news: [],
    recentFilings: [],
    contextWarnings: []
  };
}
