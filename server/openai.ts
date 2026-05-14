import type { DeterministicTradePlan, ManagerVerdict, SafetyBlocker, SignalSnapshot, SpecialistReport, TradeContext, TradeExpressionResult, TradePlan } from "../src/shared/types";
import type { AppConfig } from "./config";

interface ResponsesApiResult {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

export class OpenAiTradePlanner {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.openAiApiKey);
  }

  async createTradePlan(snapshot: SignalSnapshot, context: TradeContext, userNotes?: string, quantitativePlan?: DeterministicTradePlan, tradeExpressionResult?: TradeExpressionResult): Promise<TradePlan> {
    if (!this.config.openAiApiKey) {
      throw new Error("OpenAI API key is not configured.");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.openAiModel,
        input: [
          {
            role: "system",
            content:
              "You are a conservative swing-trading research assistant for a beginner. You do not provide financial advice or guarantees. Explain the provided deterministic quantitative plan and deterministic trade expression result; do not invent different entry, stop, target, sizing, option contracts, prices, max loss, action, or bias. Use the provided technical, earnings, news, filing, and fundamental context. Start with plain-English meaning and practical paper-trading guidance, then keep the technical thesis, risk, and checklist concise. Clearly distinguish avoid, watch, paper long candidate, paper short candidate, options paper candidate, and options research only. Never recommend live-money execution."
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create a structured paper-trade research explanation for this deterministic quantitative plan and trade expression comparison. Match the quantitative plan action, bias, entry zone, stop, targets, sizing, and warnings. Explain the recommended expression and why alternatives were rejected, but do not override deterministic max loss, warnings, kill switch, or contract data.",
              snapshot: compactSnapshot(snapshot),
              quantitativePlan: quantitativePlan ? compactQuantPlan(quantitativePlan) : undefined,
              tradeExpressionResult: tradeExpressionResult ? compactTradeExpressionResult(tradeExpressionResult) : undefined,
              context: compactContext(context),
              userNotes
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "trade_plan",
            strict: true,
            schema: {
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
            }
          }
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${text || response.statusText}`);
    }

    const data = (await response.json()) as ResponsesApiResult;
    const output = extractOutputText(data);
    if (!output) throw new Error("OpenAI response did not include structured output text.");

    return JSON.parse(output) as TradePlan;
  }

  async createManagerVerdict(input: {
    snapshot: SignalSnapshot;
    context: TradeContext;
    specialistReports: SpecialistReport[];
    safetyBlockers: SafetyBlocker[];
    userNotes?: string;
  }): Promise<ManagerVerdict> {
    if (!this.config.openAiApiKey) {
      throw new Error("OpenAI API key is not configured.");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.openAiModel,
        input: [
          {
            role: "system",
            content:
              "You are the manager of a conservative paper-trading decision center. You synthesize specialist reports, but you must never override hard safety blockers or recommend live-money execution. Give practical, beginner-friendly reasoning with bullish/base/bearish scenarios. You do not provide financial advice or guarantees."
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create a structured manager verdict from deterministic specialist reports. If any safety blocker has severity blocker, action must be avoid or watch.",
              snapshot: compactSnapshot(input.snapshot),
              context: compactContext(input.context),
              specialistReports: input.specialistReports,
              safetyBlockers: input.safetyBlockers,
              userNotes: input.userNotes
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "manager_verdict",
            strict: true,
            schema: {
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
            }
          }
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed (${response.status}): ${text || response.statusText}`);
    }

    const data = (await response.json()) as ResponsesApiResult;
    const output = extractOutputText(data);
    if (!output) throw new Error("OpenAI response did not include structured output text.");

    return JSON.parse(output) as ManagerVerdict;
  }
}

function extractOutputText(data: ResponsesApiResult): string | null {
  if (data.output_text) return data.output_text;
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) {
        return content.text;
      }
    }
  }
  return null;
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
