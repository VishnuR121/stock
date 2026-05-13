// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicTradePlanner } from "../server/anthropic";
import type { DeterministicTradePlan, SignalSnapshot, TradeContext, TradePlan } from "../src/shared/types";

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

    await expect(planner.createTradePlan(makeSnapshot(), makeContext(), undefined, makeQuantPlan())).resolves.toEqual(plan);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01"
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "claude-test",
      tool_choice: { type: "tool", name: "emit_trade_plan" }
    });
    expect(JSON.parse(body.messages[0].content).quantitativePlan).toMatchObject({
      symbol: "AAPL",
      action: "watch",
      stopLoss: 95,
      conservativeTarget: 110
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

function makeQuantPlan(): DeterministicTradePlan {
  return {
    symbol: "AAPL",
    generatedAt: "2026-05-13T14:00:00.000Z",
    currentPrice: 100,
    marketRegime: null,
    bias: "neutral",
    action: "watch",
    entryZone: { low: 99, high: 101 },
    stopLoss: 95,
    conservativeTarget: 110,
    aggressiveTarget: 112,
    riskReward: 2,
    positionSizeShares: 10,
    positionNotional: 1000,
    maxRiskDollars: 50,
    invalidationCondition: "Close below 95 invalidates the setup.",
    timeHorizon: "Swing trade.",
    keyReasons: ["Trend is constructive."],
    keyRisks: ["Paper only."],
    warnings: ["Research only."],
    ranking: {
      symbol: "AAPL",
      rawScore: 70,
      adjustedScore: 70,
      rank: 1,
      action: "watch",
      bias: "neutral",
      reasons: ["Trend is constructive."],
      warnings: ["Research only."],
      suggestedStop: 95,
      suggestedTarget: 110,
      riskReward: 2,
      components: {
        trendScore: 70,
        momentumScore: 70,
        riskRewardScore: 70,
        volumeScore: 50,
        volatilityScore: 70,
        rsiQualityScore: 80,
        marketRegimeAdjustment: 0
      }
    }
  };
}
