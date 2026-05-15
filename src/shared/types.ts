export type SignalBias = "bullish" | "neutral" | "bearish" | "caution";
export type MarketRegimeLabel = "bullish" | "neutral" | "bearish" | "caution";
export type TrendState = "uptrend" | "downtrend" | "range" | "insufficient_data";
export type OrderSide = "buy" | "sell";
export type OrderTimeInForce = "day" | "gtc";
export type OrderType = "market" | "limit";
export type OptionType = "call" | "put";
export type TradeAction =
  | "avoid"
  | "watch"
  | "paper_long_candidate"
  | "paper_short_candidate"
  | "paper_options_candidate"
  | "options_research_only";
export type TradeHorizon = "intraday" | "swing" | "position" | "options_short_term";
export type JournalStatus = "watching" | "paper_open" | "paper_closed" | "skipped";
export type JournalSourceType = "manual" | "ai_plan" | "quant_plan" | "algo_proposal" | "paper_order";
export type JournalExitReason = "target" | "stop" | "manual" | "time_exit" | "score_drop" | "other";
export type SpecialistKind = "technical" | "market" | "fundamentals" | "options" | "risk" | "journal";
export type SafetySeverity = "info" | "warning" | "blocker";
export type AnalysisMode = "fast" | "deep";
export type StrategyKind =
  | "long_stock"
  | "short_stock"
  | "long_call"
  | "long_put"
  | "call_debit_spread"
  | "put_debit_spread"
  | "covered_call"
  | "cash_secured_put"
  | "watch_only";
export type StrategySuitability = "candidate" | "watch" | "research" | "avoid";
export type AlgoProposalStatus = "queued" | "rejected" | "placed" | "blocked";
export type AlgoProposalWorkflowStatus =
  | "idea_only"
  | "needs_contract_selection"
  | "blocked"
  | "research_only"
  | "paper_eligible"
  | "paper_submitted"
  | "internally_simulated";
export type AlgoExecutionType = "long_stock_bracket" | "short_stock_bracket" | "internal_options_simulation" | "long_option" | "research_only";
export type ExitUrgency = "hold" | "watch" | "exit";
export type OpportunityCategory =
  | "bullish_long"
  | "bearish_short"
  | "bullish_options"
  | "bearish_options"
  | "neutral_income"
  | "watch_only";
export type RankingAction = "buy" | "watch" | "avoid" | "hold";
export type TradeExpressionType =
  | "long_equity"
  | "short_equity"
  | "long_call"
  | "long_put"
  | "covered_call"
  | "cash_secured_put"
  | "bull_call_debit_spread"
  | "bear_put_debit_spread"
  | "credit_spread_research"
  | "iron_condor_research"
  | "no_trade";
export type TradeExpressionDirection = "bullish" | "bearish" | "neutral";
export type TradeExpressionStatus = "research_only" | "paper_trade_allowed" | "blocked";
export type TradeExpressionPreference = "simple" | "defined_risk" | "income" | "leverage" | "capital_efficient";
export type AssetClass = "equity" | "option" | "multi_leg_option";
export type PaperExecutionMode = "broker_paper" | "internal_simulation" | "research_only";

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

export interface MarketRegimeComponent {
  symbol: string;
  price: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  momentum20Pct: number | null;
  momentum60Pct: number | null;
  drawdownFromHighPct: number | null;
  atrPct: number | null;
  score: number;
  warnings: string[];
}

export interface MarketRegimeSnapshot {
  regime: MarketRegimeLabel;
  score: number;
  explanation: string;
  riskAdjustmentMultiplier: number;
  warnings: string[];
  generatedAt: string;
  components: MarketRegimeComponent[];
}

export interface RankingComponents {
  trendScore: number;
  momentumScore: number;
  riskRewardScore: number;
  volumeScore: number;
  volatilityScore: number;
  rsiQualityScore: number;
  marketRegimeAdjustment: number;
}

export interface RankedSetup {
  symbol: string;
  rawScore: number;
  adjustedScore: number;
  rank: number;
  action: RankingAction;
  bias: SignalBias;
  reasons: string[];
  warnings: string[];
  suggestedStop: number | null;
  suggestedTarget: number | null;
  riskReward: number | null;
  components: RankingComponents;
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
  maxOpenPositions?: number;
  maxOptionsContracts?: number;
  maxStrategyExposurePct?: number;
  allowZeroDte?: boolean;
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

export interface TradePlanPriceZone {
  low: number | null;
  high: number | null;
}

export interface DeterministicTradePlan {
  symbol: string;
  generatedAt: string;
  currentPrice: number | null;
  marketRegime: MarketRegimeSnapshot | null;
  bias: SignalBias;
  action: TradeAction;
  entryZone: TradePlanPriceZone;
  stopLoss: number | null;
  conservativeTarget: number | null;
  aggressiveTarget: number | null;
  riskReward: number | null;
  positionSizeShares: number | null;
  positionNotional: number | null;
  maxRiskDollars: number | null;
  invalidationCondition: string;
  timeHorizon: string;
  keyReasons: string[];
  keyRisks: string[];
  warnings: string[];
  ranking: RankedSetup;
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
    sec: "ok" | "missing_user_agent" | "not_found" | "error";
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
  quantitativePlan?: DeterministicTradePlan;
  tradeExpressionResult?: TradeExpressionResult;
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

export interface OrderLevelDistances {
  referencePrice: number;
  targetDistancePct: number;
  stopDistancePct: number;
  targetMovePct: number;
  stopMovePct: number;
}

export interface TargetRealismResult {
  ok: boolean;
  severity: SafetySeverity;
  horizon: TradeHorizon;
  expectedHoldingPeriod: string;
  timeInForce: OrderTimeInForce;
  minutesUntilSessionClose: number | null;
  targetDistancePct: number | null;
  stopDistancePct: number | null;
  targetMovePct: number | null;
  stopMovePct: number | null;
  maxRealisticTargetPct: number | null;
  message?: string;
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

export interface StrategyCandidate {
  kind: StrategyKind;
  title: string;
  direction: "bullish" | "bearish" | "neutral" | "income";
  suitability: StrategySuitability;
  score: number;
  summary: string;
  setup: string[];
  riskNotes: string[];
  legs?: string[];
  netDebit?: number | null;
  netCredit?: number | null;
  breakeven?: number | null;
  representativeContract?: string;
  estimatedMaxLoss?: number | null;
  estimatedMaxGain?: number | null;
  probabilityOfProfit?: number | null;
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
  strategyCandidates: StrategyCandidate[];
  tradeExpressionResult?: TradeExpressionResult;
  managerVerdict: ManagerVerdict;
}

export interface AlgoTradeProposal {
  id: string;
  createdAt: string;
  updatedAt: string;
  symbol: string;
  sourceAnalysisId: string;
  signalAsOf: string;
  strategyKind: StrategyKind;
  strategyTitle: string;
  direction: StrategyCandidate["direction"];
  status: AlgoProposalStatus;
  workflowStatus?: AlgoProposalWorkflowStatus;
  executionType: AlgoExecutionType;
  horizon: TradeHorizon;
  expectedHoldingPeriod: string;
  executable: boolean;
  score: number;
  summary: string;
  setup: string[];
  riskNotes: string[];
  warnings: string[];
  blockedReasons?: string[];
  howToFix?: string[];
  expressionType?: TradeExpressionType;
  requiredCapital?: number | null;
  maxLoss?: number | null;
  maxProfit?: number | null;
  breakeven?: number | null;
  dte?: number | null;
  liquidityScore?: number | null;
  paperExecutionMode?: PaperExecutionMode;
  selectedContracts?: OptionLeg[];
  order?: PaperOrderRequest;
  multiLegOrder?: MultiLegPaperOrder;
  optionOrder?: OptionOrderRequest;
  validation?: PaperOrderValidationResult | MultiLegPaperOrderValidationResult;
  targetRealism?: TargetRealismResult;
  brokerOrder?: unknown;
  reviewedAt?: string;
  rejectionReason?: string;
}

export interface MonitoredPosition {
  symbol: string;
  assetClass?: string;
  side: "long" | "short";
  quantity: number | null;
  avgEntryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPct: number | null;
  costBasis: number | null;
  matchedProposalId?: string;
  strategyKind?: StrategyKind;
  executionType?: AlgoExecutionType;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  optionExpirationDate?: string;
  daysToExpiration?: number;
  urgency: ExitUrgency;
  suggestedAction: string;
  reasons: string[];
}

export interface PositionMonitorSnapshot {
  generatedAt: string;
  positions: MonitoredPosition[];
  openOrders: unknown[];
  summary: {
    totalPositions: number;
    exitsSuggested: number;
    watchCount: number;
    totalUnrealizedPl: number | null;
  };
}

export type SimulatedOptionQuoteStatus = "live_quote" | "entry_estimate" | "missing_pricing";

export interface SimulatedOptionsPosition {
  id: string;
  journalEntryId: string;
  symbol: string;
  underlyingSymbol: string;
  expressionType?: TradeExpressionType;
  openedAt: string;
  status: JournalStatus;
  legs: OptionLeg[];
  entryValue: number;
  currentValue: number;
  maxLoss?: number;
  maxProfit?: number;
  breakeven?: number;
  requiredCapital?: number;
  daysToExpiration: number | null;
  unrealizedPnL: number;
  unrealizedPnLPct: number | null;
  realizedPnL?: number;
  actualRMultiple?: number;
  paperExecutionMode?: PaperExecutionMode;
  quoteStatus: SimulatedOptionQuoteStatus;
  assignmentRisk: boolean;
  assignmentRiskReasons: string[];
  exitUrgency: ExitUrgency;
  suggestedAction: string;
  exitReasons: string[];
  warnings: string[];
}

export interface OptionsExposureBucket {
  key: string;
  count: number;
  maxLoss: number;
  requiredCapital: number;
  unrealizedPnL: number;
}

export interface OptionsExposureSummary {
  totalOpenSimulations: number;
  totalMaxLoss: number;
  totalRequiredCapital: number;
  totalUnrealizedPnL: number;
  byUnderlying: OptionsExposureBucket[];
  byExpressionType: OptionsExposureBucket[];
  byDteBucket: OptionsExposureBucket[];
}

export interface SimulatedOptionsSnapshot {
  generatedAt: string;
  positions: SimulatedOptionsPosition[];
  exposure: OptionsExposureSummary;
}

export interface OpportunityCandidate {
  symbol: string;
  rank: number;
  category: OpportunityCategory;
  direction: "bullish" | "bearish" | "neutral" | "income";
  opportunityScore: number;
  riskAdjustedScore: number;
  setupScore: number;
  lastPrice: number | null;
  riskReward: number | null;
  upsidePct: number | null;
  atrPct: number | null;
  volumeRatio: number | null;
  trend: TrendState;
  bias: SignalBias;
  reason: string;
  warnings: string[];
  ranking: RankedSetup;
  snapshot: SignalSnapshot;
}

export interface OpportunityScan {
  id: string;
  createdAt: string;
  dateKey: string;
  universe: string[];
  candidates: OpportunityCandidate[];
  skipped: Array<{
    symbol: string;
    reason: string;
  }>;
}

export interface BacktestRequest {
  symbols: string[];
  startDate: string;
  endDate: string;
  holdingPeriodDays: number;
  maxPositions: number;
  minScore: number;
  initialEquity?: number;
  riskPerTradePct?: number;
  maxPositionPct?: number;
  minRiskReward?: number;
  marketRegimeFilter?: MarketRegimeLabel[];
}

export type BacktestExitReason = "stop" | "target" | "holding_period" | "score_drop" | "market_regime" | "end_of_data";

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: "long";
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  stopLossPrice: number;
  targetPrice: number;
  entryScore: number;
  exitReason: BacktestExitReason;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  riskDollars: number;
}

export interface BacktestEquityPoint {
  date: string;
  equity: number;
  benchmarkEquity: number | null;
  drawdownPct: number;
}

export interface BacktestResult {
  generatedAt: string;
  request: BacktestRequest;
  totalReturnPct: number;
  annualizedReturnPct: number | null;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdownPct: number;
  numberOfTrades: number;
  profitFactor: number | null;
  benchmarkReturnPct: number | null;
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTrade[];
  warnings: string[];
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
  signalAsOf?: string;
  sourceType?: JournalSourceType;
  sourceId?: string;
  followedPlan?: boolean;
  exitReason?: JournalExitReason;
  status: JournalStatus;
  action: TradeAction;
  notes: string;
  entryPrice?: number;
  exitPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  outcome?: "win" | "loss" | "breakeven" | "open";
  pnl?: number;
  expressionType?: TradeExpressionType;
  underlyingSymbol?: string;
  assetClass?: AssetClass;
  optionLegs?: OptionLeg[];
  maxLoss?: number;
  maxProfit?: number;
  breakeven?: number;
  requiredCapital?: number;
  entryThesis?: string;
  exitThesis?: string;
  entryMarketRegime?: MarketRegimeLabel;
  entryScore?: number;
  aiConfidence?: "low" | "medium" | "high";
  paperExecutionMode?: PaperExecutionMode;
  brokerOrderIds?: string[];
  optionsMetadata?: Record<string, unknown>;
  strategyWarnings?: string[];
  realizedPnL?: number;
  actualRMultiple?: number;
  strategyCategory?: string;
}

export interface JournalTradeHighlight {
  id: string;
  symbol: string;
  pnl: number;
  rMultiple: number | null;
}

export interface JournalExpressionStat {
  key: string;
  trades: number;
  closedTrades: number;
  winRate: number;
  averageR: number | null;
  totalPnl: number;
}

export interface JournalOptionsMetrics {
  averageDteAtEntry: number | null;
  performanceByDteBucket: JournalExpressionStat[];
  performanceByOptionType: JournalExpressionStat[];
  performanceByStructure: JournalExpressionStat[];
  assignmentRiskEvents: number;
}

export interface JournalAnalytics {
  totalPaperTrades: number;
  openPaperTrades: number;
  closedPaperTrades: number;
  skippedTrades: number;
  winRate: number;
  averageR: number | null;
  totalPnl: number;
  followedPlanTrades: number;
  planDeviationTrades: number;
  followPlanRate: number | null;
  bestTrade: JournalTradeHighlight | null;
  worstTrade: JournalTradeHighlight | null;
  mostCommonSkippedReason: string | null;
  mostCommonExitReason: JournalExitReason | null;
  performanceByExpressionType: JournalExpressionStat[];
  performanceByUnderlying: JournalExpressionStat[];
  performanceByMarketRegime: JournalExpressionStat[];
  performanceByAiConfidence: JournalExpressionStat[];
  winRateByExpressionType: JournalExpressionStat[];
  averageRByExpressionType: JournalExpressionStat[];
  optionsMetrics: JournalOptionsMetrics;
}

export interface PaperOrderRequest {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity?: number;
  notional?: number;
  limitPrice?: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  timeInForce: OrderTimeInForce;
  horizon: TradeHorizon;
  earningsChecked: boolean;
  confirmedPaperOnly: boolean;
  acceptedRisk: boolean;
  sourcePlanId?: string;
  sourceSignalAsOf?: string;
  sourceAnalysisId?: string;
  sourceProposalId?: string;
  followedPlan?: boolean;
}

export interface OptionOrderRequest {
  contractSymbol: string;
  underlyingSymbol: string;
  optionType: OptionType;
  orderType: OrderType;
  quantity: number;
  limitPrice?: number;
  timeInForce: OrderTimeInForce;
  horizon: TradeHorizon;
  estimatedPremium: number | null;
  estimatedMaxLoss: number | null;
  earningsChecked: boolean;
  confirmedPaperOnly: boolean;
  acceptedRisk: boolean;
}

export interface OptionLeg {
  optionSymbol: string;
  underlyingSymbol: string;
  optionType: OptionType;
  side: "buy" | "sell";
  quantity: number;
  strike: number;
  expiration: string;
  limitPrice?: number;
  estimatedMid?: number;
  bid?: number;
  ask?: number;
  last?: number;
  delta?: number;
  theta?: number;
  vega?: number;
  impliedVolatility?: number;
  openInterest?: number | null;
  volume?: number | null;
  liquidityScore?: number | null;
}

export interface MultiLegPaperOrder {
  expressionType: TradeExpressionType;
  underlyingSymbol: string;
  legs: OptionLeg[];
  estimatedDebit?: number;
  estimatedCredit?: number;
  maxLoss: number;
  maxProfit?: number;
  breakeven?: number;
  requiredCapital: number;
  paperExecutionMode: PaperExecutionMode;
}

export interface MultiLegPaperOrderRequest extends MultiLegPaperOrder {
  timeHorizon: string;
  earningsChecked: boolean;
  confirmedPaperOnly: boolean;
  acceptedRisk: boolean;
  maxLossAcknowledged: boolean;
  paperSimulationAcknowledged: boolean;
  noLiveEndpointAcknowledged: boolean;
  sourcePlanId?: string;
  sourceSignalAsOf?: string;
  sourceAnalysisId?: string;
  sourceExpressionId?: string;
  followedPlan?: boolean;
}

export interface PaperOrderValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimatedNotional: number | null;
  estimatedRisk: number | null;
  levelDistances?: OrderLevelDistances;
  targetRealism?: TargetRealismResult;
}

export interface MultiLegPaperOrderValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  estimatedNotional: number | null;
  estimatedRisk: number | null;
  order?: MultiLegPaperOrderRequest;
}

export interface OptionIdea {
  symbol: string;
  underlyingSymbol: string;
  type: OptionType;
  expirationDate: string;
  strikePrice: number;
  closePrice: number | null;
  bidPrice?: number | null;
  askPrice?: number | null;
  midPrice?: number | null;
  lastPrice?: number | null;
  volume?: number | null;
  openInterest: number | null;
  breakeven: number | null;
  maxLoss: number | null;
  daysToExpiration?: number | null;
  moneyness?: number | null;
  intrinsicValue?: number | null;
  extrinsicValue?: number | null;
  impliedVolatility?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  probabilityOfProfit?: number | null;
  spreadWidthPct?: number | null;
  liquidityScore?: number | null;
  liquidityWarning: string | null;
}

export interface OptionSelectionDiagnostics {
  optionType: OptionType;
  moneyness: "above" | "below";
  totalContracts: number;
  typeMatches: number;
  dteEligible: number;
  priceEligible: number;
  openInterestEligible: number;
  preferredDteEligible: number;
  candidatesConsidered: number;
  selectedSymbol?: string;
  selectedExpiration?: string;
  selectedStrike?: number;
  rejectionReasons: string[];
  spread?: {
    sameExpirationContracts: number;
    priceAndOpenInterestEligible: number;
    strikeSideEligible: number;
    selectedShortSymbol?: string;
  };
}

export interface TradeExpression {
  id: string;
  expressionType: TradeExpressionType;
  underlyingSymbol: string;
  direction: TradeExpressionDirection;
  timeHorizon: string;
  confidence: number;
  maxLoss: number | null;
  maxProfit?: number | null;
  breakeven?: number | null;
  requiredCapital: number | null;
  liquidityWarnings: string[];
  volatilityWarnings: string[];
  earningsWarnings: string[];
  assignmentWarnings: string[];
  riskReward: number | null;
  rationale: string[];
  alternatives: TradeExpressionType[];
  status: TradeExpressionStatus;
  statusReasons: string[];
  dte?: number | null;
  liquidityScore?: number | null;
  paperExecutionMode?: PaperExecutionMode;
  order?: PaperOrderRequest;
  multiLegOrder?: MultiLegPaperOrder;
  optionSelectionDiagnostics?: OptionSelectionDiagnostics;
}

export interface TradeExpressionResult {
  generatedAt: string;
  underlyingSymbol: string;
  preference: TradeExpressionPreference;
  thesis: {
    ticker: string;
    marketRegime?: MarketRegimeLabel | null;
    bias: SignalBias;
    confidence: number;
    timeHorizon: string;
    entryThesis: string;
    invalidation: string;
  };
  recommendedExpression: TradeExpression;
  alternatives: TradeExpression[];
  blockedExpressions: TradeExpression[];
  riskWarnings: string[];
  paperEligibility: {
    paperOnly: boolean;
    liveTradingBlocked: boolean;
    killSwitchEnabled: boolean;
    optionsPaperMode: PaperExecutionMode;
    notes: string[];
  };
}

export interface CachedSignalSnapshot {
  savedAt: string;
  signal: SignalSnapshot;
}

export interface CachedOptionIdeas {
  savedAt: string;
  ideas: OptionIdea[];
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

export interface BrokerAssetSnapshot {
  id?: string;
  symbol: string;
  name?: string;
  assetClass?: string;
  exchange?: string;
  status?: string;
  tradable?: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easyToBorrow?: boolean;
  fractionable?: boolean;
}

export interface StoredAppData {
  watchlist: WatchlistItem[];
  tradeNotes: Record<string, string>;
  savedPlans: Record<string, SavedTradePlan>;
  analysisRuns: Record<string, AnalysisRun[]>;
  tradingViewSignals: TradingViewSignal[];
  riskSettings: RiskSettings;
  contextCache: Record<string, TradeContext>;
  signalCache: Record<string, CachedSignalSnapshot>;
  optionsCache: Record<string, CachedOptionIdeas>;
  journal: TradeJournalEntry[];
  algoTradeProposals: AlgoTradeProposal[];
  opportunityScans: OpportunityScan[];
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
  paperTradingBlockedReasons: string[];
  killSwitchEnabled: boolean;
  aiProvider: "openai" | "anthropic";
  aiConfigured: boolean;
  aiModel: string;
  openAiConfigured: boolean;
  openAiModel: string;
  anthropicConfigured: boolean;
  anthropicModel: string;
  alphaVantageConfigured: boolean;
  secUserAgentConfigured: boolean;
  tradingViewWebhookConfigured: boolean;
  databaseConfigured: boolean;
  dataStore: string;
}
