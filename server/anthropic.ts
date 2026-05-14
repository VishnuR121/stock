import type { DeterministicTradePlan, ManagerVerdict, SafetyBlocker, SignalSnapshot, SpecialistReport, TradeContext, TradeExpressionResult, TradePlan } from "../src/shared/types";
import type { AppConfig } from "./config";

interface AnthropicMessageResult {
  content?: Array<{
    type?: string;
    name?: string;
    input?: unknown;
    text?: string;
  }>;
}

type JsonSchema = Record<string, unknown>;

const TRADE_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "symbol",
    "action",
    "bias",
    "beginnerSummary",
    "summary",
    "thesis",
    "invalidation",
    "entryRequirements",
    "entryNotes",
    "doNotTradeIf",
    "riskNotes",
    "optionsNotes",
    "actionChecklist",
    "confidence",
    "warnings"
  ],
  properties: {
    symbol: { type: "string" },
    action: {
      enum: ["avoid", "watch", "paper_long_candidate", "paper_short_candidate", "options_research_only"]
    },
    bias: { enum: ["bullish", "neutral", "bearish", "caution"] },
    beginnerSummary: { type: "string" },
    summary: { type: "string" },
    thesis: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
    invalidation: { type: "string" },
    entryRequirements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
    entryNotes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    doNotTradeIf: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
    riskNotes: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
    optionsNotes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    actionChecklist: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7 },
    confidence: { enum: ["low", "medium", "high"] },
    warnings: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 }
  }
};

const MANAGER_VERDICT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "symbol",
    "action",
    "bias",
    "confidence",
    "summary",
    "scenarios",
    "entryRequirements",
    "invalidation",
    "dissent",
    "checklist",
    "warnings"
  ],
  properties: {
    symbol: { type: "string" },
    action: {
      enum: ["avoid", "watch", "paper_long_candidate", "paper_short_candidate", "options_research_only"]
    },
    bias: { enum: ["bullish", "neutral", "bearish", "caution"] },
    confidence: { enum: ["low", "medium", "high"] },
    summary: { type: "string" },
    scenarios: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "summary", "trigger"],
        properties: {
          label: { enum: ["bullish", "base", "bearish"] },
          summary: { type: "string" },
          trigger: { type: "string" }
        }
      }
    },
    entryRequirements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
    invalidation: { type: "string" },
    dissent: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
    checklist: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 7 },
    warnings: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 7 }
  }
};

export class AnthropicTradePlanner {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.anthropicApiKey);
  }

  async createTradePlan(snapshot: SignalSnapshot, context: TradeContext, userNotes?: string, quantitativePlan?: DeterministicTradePlan, tradeExpressionResult?: TradeExpressionResult): Promise<TradePlan> {
    return this.requestTool<TradePlan>({
      toolName: "emit_trade_plan",
      toolDescription: "Return the structured paper-trade research plan.",
      schema: TRADE_PLAN_SCHEMA,
      system:
        "You are a conservative swing-trading research assistant for a beginner. You do not provide financial advice or guarantees. Explain the provided deterministic quantitative plan and deterministic trade expression result; do not invent different entry, stop, target, sizing, option contracts, prices, max loss, action, or bias. Use the provided technical, earnings, news, filing, and fundamental context. Start with plain-English meaning and practical paper-trading guidance, then keep the technical thesis, risk, and checklist concise. Clearly distinguish avoid, watch, paper long candidate, paper short candidate, options paper candidate, and options research only. Never recommend live-money execution.",
      userPayload: {
        task: "Create a structured paper-trade research explanation for this deterministic quantitative plan and trade expression comparison. Match the quantitative plan action, bias, entry zone, stop, targets, sizing, and warnings. Explain the recommended expression and why alternatives were rejected, but do not override deterministic max loss, warnings, kill switch, or contract data.",
        snapshot: compactSnapshot(snapshot),
        quantitativePlan: quantitativePlan ? compactQuantPlan(quantitativePlan) : undefined,
        tradeExpressionResult: tradeExpressionResult ? compactTradeExpressionResult(tradeExpressionResult) : undefined,
        context: compactContext(context),
        userNotes
      }
    });
  }

  async createManagerVerdict(input: {
    snapshot: SignalSnapshot;
    context: TradeContext;
    specialistReports: SpecialistReport[];
    safetyBlockers: SafetyBlocker[];
    userNotes?: string;
  }): Promise<ManagerVerdict> {
    return this.requestTool<ManagerVerdict>({
      toolName: "emit_manager_verdict",
      toolDescription: "Return the structured manager verdict.",
      schema: MANAGER_VERDICT_SCHEMA,
      system:
        "You are the manager of a conservative paper-trading decision center. You synthesize specialist reports, but you must never override hard safety blockers or recommend live-money execution. Give practical, beginner-friendly reasoning with bullish/base/bearish scenarios. You do not provide financial advice or guarantees.",
      userPayload: {
        task: "Create a structured manager verdict from deterministic specialist reports. If any safety blocker has severity blocker, action must be avoid or watch.",
        snapshot: compactSnapshot(input.snapshot),
        context: compactContext(input.context),
        specialistReports: input.specialistReports,
        safetyBlockers: input.safetyBlockers,
        userNotes: input.userNotes
      }
    });
  }

  private async requestTool<T>(input: {
    toolName: string;
    toolDescription: string;
    schema: JsonSchema;
    system: string;
    userPayload: unknown;
  }): Promise<T> {
    if (!this.config.anthropicApiKey) {
      throw new Error("Anthropic API key is not configured.");
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.anthropicModel,
        max_tokens: 1800,
        system: input.system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(input.userPayload)
          }
        ],
        tools: [
          {
            name: input.toolName,
            description: input.toolDescription,
            input_schema: input.schema
          }
        ],
        tool_choice: {
          type: "tool",
          name: input.toolName
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${text || response.statusText}`);
    }

    const data = (await response.json()) as AnthropicMessageResult;
    const toolUse = data.content?.find((content) => content.type === "tool_use" && content.name === input.toolName);
    if (!toolUse?.input || typeof toolUse.input !== "object") {
      throw new Error("Anthropic response did not include the expected structured tool output.");
    }

    return toolUse.input as T;
  }
}

function compactSnapshot(snapshot: SignalSnapshot) {
  const { bars, ...rest } = snapshot;
  return {
    ...rest,
    bars: bars.slice(-30)
  };
}

function compactContext(context: TradeContext) {
  return {
    symbol: context.symbol,
    generatedAt: context.generatedAt,
    providers: context.providers,
    fundamentals: context.fundamentals,
    earnings: context.earnings,
    news: context.news.slice(0, 6),
    recentFilings: context.recentFilings.slice(0, 6),
    secFacts: context.secFacts,
    contextWarnings: context.contextWarnings
  };
}

function compactQuantPlan(plan: DeterministicTradePlan) {
  return {
    symbol: plan.symbol,
    generatedAt: plan.generatedAt,
    currentPrice: plan.currentPrice,
    marketRegime: plan.marketRegime ? {
      regime: plan.marketRegime.regime,
      score: plan.marketRegime.score,
      riskAdjustmentMultiplier: plan.marketRegime.riskAdjustmentMultiplier,
      warnings: plan.marketRegime.warnings
    } : null,
    bias: plan.bias,
    action: plan.action,
    entryZone: plan.entryZone,
    stopLoss: plan.stopLoss,
    conservativeTarget: plan.conservativeTarget,
    aggressiveTarget: plan.aggressiveTarget,
    riskReward: plan.riskReward,
    positionSizeShares: plan.positionSizeShares,
    maxRiskDollars: plan.maxRiskDollars,
    invalidationCondition: plan.invalidationCondition,
    timeHorizon: plan.timeHorizon,
    keyReasons: plan.keyReasons,
    keyRisks: plan.keyRisks,
    warnings: plan.warnings,
    ranking: {
      rawScore: plan.ranking.rawScore,
      adjustedScore: plan.ranking.adjustedScore,
      action: plan.ranking.action,
      reasons: plan.ranking.reasons,
      warnings: plan.ranking.warnings,
      components: plan.ranking.components
    }
  };
}

function compactTradeExpressionResult(result: TradeExpressionResult) {
  return {
    preference: result.preference,
    thesis: result.thesis,
    recommendedExpression: compactExpression(result.recommendedExpression),
    alternatives: result.alternatives.slice(0, 5).map(compactExpression),
    blockedExpressions: result.blockedExpressions.slice(0, 5).map((expression) => ({
      expressionType: expression.expressionType,
      statusReasons: expression.statusReasons
    })),
    riskWarnings: result.riskWarnings,
    paperEligibility: result.paperEligibility
  };
}

function compactExpression(expression: TradeExpressionResult["recommendedExpression"]) {
  return {
    expressionType: expression.expressionType,
    direction: expression.direction,
    status: expression.status,
    statusReasons: expression.statusReasons,
    maxLoss: expression.maxLoss,
    maxProfit: expression.maxProfit,
    breakeven: expression.breakeven,
    requiredCapital: expression.requiredCapital,
    riskReward: expression.riskReward,
    dte: expression.dte,
    liquidityWarnings: expression.liquidityWarnings,
    volatilityWarnings: expression.volatilityWarnings,
    earningsWarnings: expression.earningsWarnings,
    assignmentWarnings: expression.assignmentWarnings,
    legs: expression.multiLegOrder?.legs.map((leg) => ({
      optionSymbol: leg.optionSymbol,
      optionType: leg.optionType,
      side: leg.side,
      strike: leg.strike,
      expiration: leg.expiration,
      estimatedMid: leg.estimatedMid,
      bid: leg.bid,
      ask: leg.ask
    }))
  };
}
