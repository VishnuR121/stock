import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const DEFAULT_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_SEC_USER_AGENT = "ResearchCopilot/0.1 contact@example.com";

export type AiProvider = "openai" | "anthropic";

export interface AppConfig {
  port: number;
  alpacaKeyId?: string;
  alpacaSecretKey?: string;
  alpacaPaperBaseUrl: string;
  aiProvider: AiProvider;
  openAiApiKey?: string;
  openAiModel: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  alphaVantageApiKey?: string;
  secUserAgent: string;
  databaseUrl?: string;
  dataFilePath: string;
  tradingViewWebhookSecret?: string;
}

export function getConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: Number(process.env.PORT || 3001),
    alpacaKeyId: process.env.ALPACA_API_KEY_ID,
    alpacaSecretKey: process.env.ALPACA_API_SECRET_KEY,
    alpacaPaperBaseUrl: process.env.ALPACA_PAPER_BASE_URL || DEFAULT_PAPER_BASE_URL,
    aiProvider: normalizeAiProvider(process.env.AI_PROVIDER),
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
    secUserAgent: process.env.SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT,
    databaseUrl: process.env.DATABASE_URL,
    dataFilePath: process.env.DATA_FILE_PATH || "data/app-data.json",
    tradingViewWebhookSecret: process.env.TRADINGVIEW_WEBHOOK_SECRET,
    ...overrides
  };
}

function normalizeAiProvider(value?: string): AiProvider {
  return value?.toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

export function isPaperAlpacaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "paper-api.alpaca.markets";
  } catch {
    return false;
  }
}

export function isConfiguredSecUserAgent(userAgent: string): boolean {
  return Boolean(userAgent.trim()) && userAgent !== DEFAULT_SEC_USER_AGENT;
}
