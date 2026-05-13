import type { DeterministicTradePlan, ManagerVerdict, SafetyBlocker, SignalSnapshot, SpecialistReport, TradeContext, TradePlan } from "../src/shared/types";
import type { AppConfig } from "./config";
import { AnthropicTradePlanner } from "./anthropic";
import { OpenAiTradePlanner } from "./openai";

export interface AiTradePlanner {
  readonly configured: boolean;
  createTradePlan(snapshot: SignalSnapshot, context: TradeContext, userNotes?: string, quantitativePlan?: DeterministicTradePlan): Promise<TradePlan>;
  createManagerVerdict(input: {
    snapshot: SignalSnapshot;
    context: TradeContext;
    specialistReports: SpecialistReport[];
    safetyBlockers: SafetyBlocker[];
    userNotes?: string;
  }): Promise<ManagerVerdict>;
}

export function createTradePlanner(config: AppConfig): AiTradePlanner {
  return config.aiProvider === "anthropic"
    ? new AnthropicTradePlanner(config)
    : new OpenAiTradePlanner(config);
}
