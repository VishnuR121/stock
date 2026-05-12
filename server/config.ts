import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const DEFAULT_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export interface AppConfig {
  port: number;
  alpacaKeyId?: string;
  alpacaSecretKey?: string;
  alpacaPaperBaseUrl: string;
  openAiApiKey?: string;
  openAiModel: string;
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
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiModel: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
    secUserAgent: process.env.SEC_USER_AGENT || "ResearchCopilot/0.1 contact@example.com",
    databaseUrl: process.env.DATABASE_URL,
    dataFilePath: process.env.DATA_FILE_PATH || "data/app-data.json",
    tradingViewWebhookSecret: process.env.TRADINGVIEW_WEBHOOK_SECRET,
    ...overrides
  };
}

export function isPaperAlpacaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "paper-api.alpaca.markets";
  } catch {
    return false;
  }
}
