import type { SignalSnapshot, TradeContext, TradePlan } from "../src/shared/types";
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

  async createTradePlan(snapshot: SignalSnapshot, context: TradeContext, userNotes?: string): Promise<TradePlan> {
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
              "You are a conservative swing-trading research assistant for a beginner. You do not provide financial advice or guarantees. Use the provided technical, earnings, news, filing, and fundamental context. Start with plain-English meaning and practical paper-trading guidance, then keep the technical thesis, risk, and checklist concise. Clearly distinguish avoid, watch, paper long candidate, paper short candidate, and options research only. Never recommend live-money execution."
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create a structured paper-trade research plan for this technical snapshot. The summary should be understandable to someone new to markets, while the thesis and risk sections may include technical detail.",
              snapshot: compactSnapshot(snapshot),
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
