export type SignalBias = "bullish" | "neutral" | "bearish" | "caution";
export type TrendState = "uptrend" | "downtrend" | "range" | "insufficient_data";
export type OrderTimeInForce = "day" | "gtc";
export type OrderType = "market" | "limit";
export type OptionType = "call" | "put";
export type TradeAction =
  | "avoid"
  | "watch"
  | "paper_long_candidate"
  | "paper_short_candidate"
  | "options_research_only";
export type JournalStatus = "watching" | "paper_open" | "paper_closed" | "skipped";
export type SpecialistKind = "technical" | "market" | "fundamentals" | "options" | "risk" | "journal";
export type SafetySeverity = "info" | "warning" | "blocker";
export type AnalysisMode = "fast" | "deep";

export interface WatchlistItem {
  symbol: string;
  notes?: string;
  tags: string[];
  createdAt: string;
}

export interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalSnapshot {
  symbol: string;
  asOf: string;
  lastPrice: number | null;
  previousClose: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  atr14: number | null;
  volumeRatio: number | null;
  recentHigh: number | null;
  recentLow: number | null;
  suggestedStop: number | null;
  suggestedTarget: number | null;
  riskReward: number | null;
  trend: TrendState;
  bias: SignalBias;
  score: number;
  positionSizeShares: number | null;
  positionNotional: number | null;
  riskDollars: number | null;
  notes: string[];
  bars: Bar[];
}

export interface RiskProfile {
  accountEquity: number;
  maxRiskPerTradePct: number;
  maxPositionPct: number;
  maxDailyLossPct: number;
  minRiskReward: number;
}

export interface RiskSettings {
  maxRiskPerTradePct: number;
  maxPositionPct: number;
  maxDailyLossPct: number;
  minRiskReward: number;
  maxDataAgeMinutes: number;
  priceCollarPct: number;
  earningsWindowDays: number;
  killSwitchEnabled: boolean;
}

export interface TradePlan {
  symbol: string;
  action?: TradeAction;
  bias: SignalBias;
  beginnerSummary?: string;
  summary: string;
  thesis: string[];
  invalidation: string;
  entryRequirements?: string[];
  entryNotes: string[];
  doNotTradeIf?: string[];
  riskNotes: string[];
  optionsNotes?: string[];
  actionChecklist: string[];
  confidence: "low" | "medium" | "high";
  warnings: string[];
}

export interface FundamentalSnapshot {
  source: string;
  name?: string;
  sector?: string;
  industry?: string;
  marketCapitalization?: string;
  peRatio?: string;
  pegRatio?: string;
  profitMargin?: string;
  revenueTtm?: string;
  epsTtm?: string;
  dividendYield?: string;
  beta?: string;
  notes: string[];
}

export interface EarningsContext {
  source: string;
  nextEarningsDate?: string;
  nextReportTime?: string;
  latestReportedQuarter?: string;
  latestReportedEps?: string;
  latestEstimatedEps?: string;
  latestSurprisePercentage?: string;
  notes: string[];
}

export interface NewsItem {
  title: string;
  url?: string;
  source?: string;
  publishedAt?: string;
  summary?: string;
  sentiment?: string;
}

export interface FilingItem {
  form: string;
  filedAt: string;
  reportDate?: string;
  accessionNumber?: string;
  description?: string;
  url?: string;
}

export interface SecCompanyFacts {
  cik?: string;
  entityName?: string;
  latestRevenue?: number | null;
  latestNetIncome?: number | null;
  latestAssets?: number | null;
  latestLiabilities?: number | null;
  latestCash?: number | null;
  notes: string[];
}

export interface TradeContext {
  symbol: string;
  generatedAt: string;
  providers: {
    alpaca: "ok" | "missing" | "error";
    alphaVantage: "ok" | "missing_key" | "rate_limited" | "error";
    sec: "ok" | "not_found" | "error";
  };
  fundamentals?: FundamentalSnapshot;
  earnings?: EarningsContext;
  news: NewsItem[];
  recentFilings: FilingItem[];
  secFacts?: SecCompanyFacts;
  contextWarnings: string[];
}

export interface EnrichedTradePlanResponse {
  plan: TradePlan;
  context: TradeContext;
  savedPlan: SavedTradePlan;
}

export interface SavedTradePlan {
  id: string;
  symbol: string;
  createdAt: string;
  signalAsOf: string;
  score: number;
  plan: TradePlan;
  context: TradeContext;
}

export interface SpecialistReport {
  kind: SpecialistKind;
  title: string;
  score: number;
  bias: SignalBias;
  summary: string;
  evidence: string[];
  warnings: string[];
}

export interface SafetyBlocker {
  code: string;
  severity: SafetySeverity;
  message: string;
}

export interface ManagerScenario {
  label: "bullish" | "base" | "bearish";
  summary: string;
  trigger: string;
}

export interface ManagerVerdict {
  symbol: string;
  action: TradeAction;
  bias: SignalBias;
  confidence: "low" | "medium" | "high";
  summary: string;
  scenarios: ManagerScenario[];
  entryRequirements: string[];
  invalidation: string;
  dissent: string[];
  checklist: string[];
  warnings: string[];
}

export interface AnalysisRun {
  id: string;
  symbol: string;
  createdAt: string;
  mode: AnalysisMode;
  signalAsOf: string;
  snapshot: SignalSnapshot;
  context: TradeContext;
  specialistReports: SpecialistReport[];
  safetyBlockers: SafetyBlocker[];
  managerVerdict: ManagerVerdict;
}

export interface TradingViewSignal {
  id: string;
  createdAt: string;
  symbol: string;
  alertName?: string;
  timeframe?: string;
  message: string;
  payload: Record<string, unknown>;
  status: "received" | "analyzed" | "ignored";
}

export interface TradeJournalEntry {
  id: string;
  symbol: string;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  status: JournalStatus;
  action: TradeAction;
  notes: string;
  entryPrice?: number;
  exitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  outcome?: "win" | "loss" | "breakeven" | "open";
  pnl?: number;
}

export interface PaperOrderRequest {
  symbol: string;
  orderType: OrderType;
  quantity?: number;
  notional?: number;
  limitPrice?: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  timeInForce: OrderTimeInForce;
  earningsChecked: boolean;
  confirmedPaperOnly: boolean;
  acceptedRisk: boolean;
}

export interface PaperOrderValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimatedNotional: number | null;
  estimatedRisk: number | null;
}

export interface OptionIdea {
  symbol: string;
  underlyingSymbol: string;
  type: OptionType;
  expirationDate: string;
  strikePrice: number;
  closePrice: number | null;
  openInterest: number | null;
  breakeven: number | null;
  maxLoss: number | null;
  liquidityWarning: string | null;
}

export interface BrokerAccountSnapshot {
  id?: string;
  status?: string;
  currency?: string;
  equity: number | null;
  cash: number | null;
  buyingPower: number | null;
  portfolioValue: number | null;
  paper: boolean;
}

export interface StoredAppData {
  watchlist: WatchlistItem[];
  tradeNotes: Record<string, string>;
  savedPlans: Record<string, SavedTradePlan>;
  analysisRuns: Record<string, AnalysisRun[]>;
  tradingViewSignals: TradingViewSignal[];
  riskSettings: RiskSettings;
  contextCache: Record<string, TradeContext>;
  journal: TradeJournalEntry[];
  scanHistory: Array<{
    id: string;
    createdAt: string;
    symbols: string[];
    snapshots: SignalSnapshot[];
  }>;
}

export interface HealthStatus {
  ok: boolean;
  alpacaConfigured: boolean;
  alpacaPaperOnly: boolean;
  openAiConfigured: boolean;
  openAiModel: string;
  alphaVantageConfigured: boolean;
  databaseConfigured: boolean;
  dataStore: string;
}
