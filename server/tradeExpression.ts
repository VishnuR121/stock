import type {
  BrokerAccountSnapshot,
  MarketRegimeSnapshot,
  MultiLegPaperOrder,
  OptionIdea,
  OptionLeg,
  OptionSelectionDiagnostics,
  PaperOrderRequest,
  PaperExecutionMode,
  RiskSettings,
  SignalSnapshot,
  TradeExpression,
  TradeExpressionDirection,
  TradeExpressionPreference,
  TradeExpressionResult,
  TradeExpressionStatus,
  TradeExpressionType
} from "../src/shared/types";
import { round } from "./indicators";
import {
  enrichOptionIdeas,
  getCashSecuredPutMetrics,
  getCoveredCallMetrics,
  getDaysToExpiration,
  getDebitSpreadMetrics,
  getOptionPrice
} from "./options";

export interface TradeExpressionEngineInput {
  snapshot: SignalSnapshot;
  marketRegime?: MarketRegimeSnapshot | null;
  currentHoldings: unknown[];
  riskSettings: RiskSettings;
  account: Partial<BrokerAccountSnapshot> | { equity?: number | null; cash?: number | null; buyingPower?: number | null; paper?: boolean };
  options: OptionIdea[];
  earningsDate?: string;
  preference?: TradeExpressionPreference;
  now?: Date;
}

const OPTIONS_PAPER_MODE: PaperExecutionMode = "internal_simulation";

export function buildTradeExpressionResult(input: TradeExpressionEngineInput): TradeExpressionResult {
  const now = input.now ?? new Date();
  const snapshot = input.snapshot;
  const symbol = snapshot.symbol.toUpperCase();
  const currentPrice = snapshot.lastPrice;
  const equity = getAccountNumber(input.account.equity, 100000);
  const buyingPower = getAccountNumber(input.account.buyingPower, getAccountNumber(input.account.cash, equity));
  const cash = getAccountNumber(input.account.cash, buyingPower);
  const maxRisk = equity * input.riskSettings.maxRiskPerTradePct;
  const maxPosition = equity * input.riskSettings.maxPositionPct;
  const maxStrategyExposure = equity * (input.riskSettings.maxStrategyExposurePct ?? input.riskSettings.maxPositionPct);
  const preference = input.preference ?? getDefaultPreference(snapshot);
  const options = enrichOptionIdeas(input.options, currentPrice, now);
  const holdings = getHoldingSnapshot(input.currentHoldings, symbol);
  const riskWarnings = getGlobalRiskWarnings(input, equity, now);
  const eventWarnings = getEarningsWarnings(input.earningsDate, input.riskSettings, now);
  const hardBlocked = input.riskSettings.killSwitchEnabled
    || !currentPrice
    || riskWarnings.some((warning) => /older than|Open position count|current underlying price/i.test(warning));
  const timeHorizon = getTimeHorizon(snapshot);

  const candidates = [
    buildLongEquity({ snapshot, currentPrice, equity, buyingPower, maxRisk, maxPosition, hardBlocked, eventWarnings, timeHorizon }),
    buildShortEquity({ snapshot, currentPrice, equity, buyingPower, maxRisk, maxPosition, hardBlocked, eventWarnings, timeHorizon }),
    buildLongOption("long_call", "call", {
      symbol,
      direction: "bullish",
      currentPrice,
      options,
      maxRisk,
      buyingPower,
      riskSettings: input.riskSettings,
      hardBlocked,
      eventWarnings,
      confidence: snapshot.score,
      timeHorizon: "Flexible DTE swing options (prefers 14-60)",
      directionalFit: isBullish(snapshot)
    }),
    buildLongOption("long_put", "put", {
      symbol,
      direction: "bearish",
      currentPrice,
      options,
      maxRisk,
      buyingPower,
      riskSettings: input.riskSettings,
      hardBlocked,
      eventWarnings,
      confidence: 100 - snapshot.score,
      timeHorizon: "Flexible DTE swing options (prefers 14-60)",
      directionalFit: isBearish(snapshot)
    }),
    buildDebitSpread("bull_call_debit_spread", "call", {
      symbol,
      direction: "bullish",
      currentPrice,
      options,
      maxRisk,
      buyingPower,
      riskSettings: input.riskSettings,
      hardBlocked,
      eventWarnings,
      confidence: snapshot.score,
      timeHorizon: "Flexible DTE defined-risk spread (prefers 14-60)",
      directionalFit: isBullish(snapshot)
    }),
    buildDebitSpread("bear_put_debit_spread", "put", {
      symbol,
      direction: "bearish",
      currentPrice,
      options,
      maxRisk,
      buyingPower,
      riskSettings: input.riskSettings,
      hardBlocked,
      eventWarnings,
      confidence: 100 - snapshot.score,
      timeHorizon: "Flexible DTE defined-risk spread (prefers 14-60)",
      directionalFit: isBearish(snapshot)
    }),
    buildCoveredCall({
      symbol,
      currentPrice,
      options,
      holdings,
      maxRisk,
      riskSettings: input.riskSettings,
      hardBlocked,
      eventWarnings,
      confidence: getIncomeConfidence(snapshot),
      timeHorizon: "Flexible DTE income overlay (prefers 14-60)"
    }),
    buildCashSecuredPut({
      symbol,
      currentPrice,
      options,
      cash,
      maxRisk,
      maxStrategyExposure,
      riskSettings: input.riskSettings,
      hardBlocked,
      eventWarnings,
      confidence: getIncomeConfidence(snapshot),
      timeHorizon: "Flexible DTE income entry (prefers 14-60)",
      directionalFit: isBullish(snapshot) || snapshot.bias === "neutral" || snapshot.trend === "range"
    }),
    researchOnlyExpression({
      expressionType: "credit_spread_research",
      symbol,
      direction: "neutral",
      confidence: getIncomeConfidence(snapshot),
      rationale: ["Credit spreads stay research-only until defined broker support and assignment workflows are explicit."],
      warnings: ["Short premium strategies are not enabled for paper submission in this phase."]
    }),
    researchOnlyExpression({
      expressionType: "iron_condor_research",
      symbol,
      direction: "neutral",
      confidence: getIncomeConfidence(snapshot),
      rationale: ["Iron condors remain research-only because they combine multiple short option assignment paths."],
      warnings: ["No autonomous or live options execution is supported."]
    }),
    buildNoTradeExpression(symbol, snapshot, riskWarnings, hardBlocked)
  ];

  const ranked = rankExpressions(candidates, preference, snapshot);
  const recommendedExpression = chooseRecommendation(ranked, snapshot, hardBlocked);
  const alternatives = ranked
    .filter((candidate) => candidate.id !== recommendedExpression.id && candidate.status !== "blocked")
    .slice(0, 8);
  const blockedExpressions = ranked.filter((candidate) => candidate.status === "blocked");
  const alternativeTypes = alternatives.map((candidate) => candidate.expressionType);
  const completedRecommended = { ...recommendedExpression, alternatives: alternativeTypes };

  return {
    generatedAt: now.toISOString(),
    underlyingSymbol: symbol,
    preference,
    thesis: {
      ticker: symbol,
      marketRegime: input.marketRegime?.regime ?? null,
      bias: snapshot.bias,
      confidence: clampConfidence(snapshot.score),
      timeHorizon,
      entryThesis: snapshot.notes[0] ?? `Current deterministic bias is ${snapshot.bias}.`,
      invalidation: snapshot.suggestedStop
        ? `Underlying invalidates near ${snapshot.suggestedStop}.`
        : "No validated invalidation level is available."
    },
    recommendedExpression: completedRecommended,
    alternatives: alternatives.map((candidate) => ({ ...candidate, alternatives: alternativeTypes.filter((type) => type !== candidate.expressionType) })),
    blockedExpressions,
    riskWarnings,
    paperEligibility: {
      paperOnly: input.account.paper !== false,
      liveTradingBlocked: true,
      killSwitchEnabled: input.riskSettings.killSwitchEnabled,
      optionsPaperMode: OPTIONS_PAPER_MODE,
      notes: [
        "Equity brackets use Alpaca paper only after manual confirmation.",
        "Algo options proposals can use broker-paper submission after exact contract selection and deterministic validation; advanced Trade Expression drafts remain internal simulations.",
        "No live trading, naked options, 0DTE by default, or AI auto-execution is enabled."
      ]
    }
  };
}

function buildLongEquity(input: {
  snapshot: SignalSnapshot;
  currentPrice: number | null;
  equity: number;
  buyingPower: number;
  maxRisk: number;
  maxPosition: number;
  hardBlocked: boolean;
  eventWarnings: string[];
  timeHorizon: string;
}): TradeExpression {
  const symbol = input.snapshot.symbol.toUpperCase();
  const stop = input.snapshot.suggestedStop;
  const target = input.snapshot.suggestedTarget;
  const price = input.currentPrice;
  const errors: string[] = [];
  if (input.hardBlocked) errors.push("Global paper-trading blockers must be resolved first.");
  if (!isBullish(input.snapshot)) errors.push("The current deterministic setup is not bullish enough for long equity.");
  if (!price || !stop || !target) errors.push("Long equity requires current price, stop, and target.");
  if (price && stop && stop >= price) errors.push("Long equity stop must be below entry.");
  if (price && target && target <= price) errors.push("Long equity target must be above entry.");

  const quantity = price && stop ? Math.max(0, Math.floor(input.maxRisk / Math.max(price - stop, 0.01))) : 0;
  const cappedQuantity = price ? Math.min(quantity, Math.floor(input.maxPosition / price), input.snapshot.positionSizeShares ?? quantity) : 0;
  const maxLoss = price && stop && cappedQuantity > 0 ? round((price - stop) * cappedQuantity, 2) : null;
  const requiredCapital = price && cappedQuantity > 0 ? round(price * cappedQuantity, 2) : null;
  const maxProfit = price && target && cappedQuantity > 0 ? round((target - price) * cappedQuantity, 2) : null;
  if (maxLoss !== null && maxLoss > input.maxRisk) errors.push("Estimated loss exceeds max per-trade risk.");
  if (requiredCapital !== null && requiredCapital > input.maxPosition) errors.push("Required capital exceeds max position size.");
  if (requiredCapital !== null && requiredCapital > input.buyingPower) errors.push("Required capital exceeds available paper buying power.");
  if (cappedQuantity <= 0) errors.push("No share quantity fits the current risk controls.");

  const order: PaperOrderRequest | undefined = errors.length || !price || !stop || !target || cappedQuantity <= 0
    ? undefined
    : {
      symbol,
      side: "buy",
      orderType: "market",
      quantity: cappedQuantity,
      stopLossPrice: stop,
      takeProfitPrice: target,
      timeInForce: input.snapshot.bias === "bullish" ? "gtc" : "day",
      horizon: "swing",
      earningsChecked: false,
      confirmedPaperOnly: false,
      acceptedRisk: false
    };

  return expression({
    expressionType: "long_equity",
    symbol,
    direction: "bullish",
    confidence: input.snapshot.score,
    maxLoss,
    maxProfit,
    breakeven: price,
    requiredCapital,
    riskReward: maxLoss && maxProfit ? round(maxProfit / maxLoss, 2) : input.snapshot.riskReward,
    status: errors.length ? "blocked" : "paper_trade_allowed",
    statusReasons: errors,
    earningsWarnings: input.eventWarnings,
    rationale: [
      "Shares are the simplest bullish expression and keep risk tied to the underlying stop.",
      `Position size is capped by max risk and max notional settings.`
    ],
    paperExecutionMode: "broker_paper",
    order,
    timeHorizon: input.timeHorizon
  });
}

function buildShortEquity(input: {
  snapshot: SignalSnapshot;
  currentPrice: number | null;
  equity: number;
  buyingPower: number;
  maxRisk: number;
  maxPosition: number;
  hardBlocked: boolean;
  eventWarnings: string[];
  timeHorizon: string;
}): TradeExpression {
  const symbol = input.snapshot.symbol.toUpperCase();
  const price = input.currentPrice;
  const atr = input.snapshot.atr14 ?? (price ? price * 0.04 : null);
  const stop = price && atr ? round(price + Math.max(atr, price * 0.03), 2) : null;
  const riskPerShare = price && stop ? stop - price : null;
  const target = price && riskPerShare ? round(price - riskPerShare * Math.max(1.8, input.snapshot.riskReward ?? 2), 2) : null;
  const errors: string[] = [];
  if (input.hardBlocked) errors.push("Global paper-trading blockers must be resolved first.");
  if (!isBearish(input.snapshot)) errors.push("The current deterministic setup is not bearish enough for short equity.");
  if (!price || !stop || !target || !riskPerShare || riskPerShare <= 0) errors.push("Short equity requires a current price and stop above entry.");
  if (target !== null && target <= 0) errors.push("Short target would be unrealistic.");

  const quantity = price && riskPerShare ? Math.max(0, Math.floor(input.maxRisk / riskPerShare)) : 0;
  const cappedQuantity = price ? Math.min(quantity, Math.floor(input.maxPosition / price)) : 0;
  const maxLoss = riskPerShare && cappedQuantity > 0 ? round(riskPerShare * cappedQuantity, 2) : null;
  const requiredCapital = price && cappedQuantity > 0 ? round(price * cappedQuantity, 2) : null;
  const maxProfit = price && target && cappedQuantity > 0 ? round((price - target) * cappedQuantity, 2) : null;
  if (maxLoss !== null && maxLoss > input.maxRisk) errors.push("Estimated short loss exceeds max per-trade risk.");
  if (requiredCapital !== null && requiredCapital > input.maxPosition) errors.push("Short notional exceeds max position size.");
  if (requiredCapital !== null && requiredCapital > input.buyingPower) errors.push("Required short margin exceeds available paper buying power.");
  if (cappedQuantity <= 0) errors.push("No short share quantity fits the current risk controls.");

  const order: PaperOrderRequest | undefined = errors.length || !stop || !target || cappedQuantity <= 0
    ? undefined
    : {
      symbol,
      side: "sell",
      orderType: "market",
      quantity: cappedQuantity,
      stopLossPrice: stop,
      takeProfitPrice: target,
      timeInForce: "gtc",
      horizon: "swing",
      earningsChecked: false,
      confirmedPaperOnly: false,
      acceptedRisk: false
    };

  return expression({
    expressionType: "short_equity",
    symbol,
    direction: "bearish",
    confidence: 100 - input.snapshot.score,
    maxLoss,
    maxProfit,
    breakeven: price,
    requiredCapital,
    riskReward: maxLoss && maxProfit ? round(maxProfit / maxLoss, 2) : null,
    status: errors.length ? "blocked" : "paper_trade_allowed",
    statusReasons: errors,
    earningsWarnings: input.eventWarnings,
    assignmentWarnings: ["Short equity losses can exceed the planned stop if price gaps higher."],
    rationale: [
      "Short equity is only considered with an explicit stop and max-loss estimate.",
      "Borrow availability is not available from the current provider response and must be reviewed manually."
    ],
    paperExecutionMode: "broker_paper",
    order,
    timeHorizon: input.timeHorizon
  });
}

function buildLongOption(
  expressionType: "long_call" | "long_put",
  optionType: "call" | "put",
  input: OptionExpressionInput
): TradeExpression {
  const selection = selectSingleOption(input.options, optionType, input.currentPrice, undefined, input.riskSettings);
  const option = selection.option;
  const price = getOptionPrice(option);
  const dte = option?.daysToExpiration ?? (option ? getDaysToExpiration(option.expirationDate, new Date()) : null);
  const maxLoss = price ? round(price * 100, 2) : null;
  const errors = getOptionEligibilityErrors({ option, price, dte, maxLoss, requiredCapital: maxLoss, input });
  if (!input.directionalFit) errors.push(`${formatExpressionType(expressionType)} does not fit the current directional bias.`);
  const warnings = getOptionWarnings(option, dte, input.eventWarnings);
  const order = option && price && maxLoss !== null
    ? buildMultiLegOrder({
      expressionType,
      symbol: input.symbol,
      legs: [toOptionLeg(option, "buy")],
      estimatedDebit: maxLoss,
      maxLoss,
      breakeven: option.breakeven ?? undefined,
      requiredCapital: maxLoss
    })
    : undefined;

  return expression({
    expressionType,
    symbol: input.symbol,
    direction: input.direction,
    confidence: input.confidence,
    maxLoss,
    maxProfit: null,
    breakeven: option?.breakeven ?? null,
    requiredCapital: maxLoss,
    riskReward: null,
    liquidityWarnings: warnings.liquidity,
    volatilityWarnings: warnings.volatility,
    earningsWarnings: warnings.earnings,
    status: errors.length ? "blocked" : "paper_trade_allowed",
    statusReasons: errors,
    rationale: [
      `${formatExpressionType(expressionType)} gives defined-risk directional exposure.`,
      "Max loss is limited to premium paid, but time decay can still make a correct direction lose money."
    ],
    dte,
    liquidityScore: option?.liquidityScore ?? null,
    paperExecutionMode: OPTIONS_PAPER_MODE,
    multiLegOrder: order,
    optionSelectionDiagnostics: selection.diagnostics,
    timeHorizon: input.timeHorizon
  });
}

function buildDebitSpread(
  expressionType: "bull_call_debit_spread" | "bear_put_debit_spread",
  optionType: "call" | "put",
  input: OptionExpressionInput
): TradeExpression {
  const spread = selectDebitSpread(input.options, optionType, input.currentPrice, input.riskSettings);
  const metrics = getDebitSpreadMetrics({ type: optionType, longLeg: spread?.longLeg, shortLeg: spread?.shortLeg });
  const dte = spread?.longLeg?.daysToExpiration ?? null;
  const requiredCapital = metrics.maxLoss;
  const errors = getOptionEligibilityErrors({ option: spread?.longLeg, price: metrics.netDebit, dte, maxLoss: metrics.maxLoss, requiredCapital, input });
  if (!spread?.shortLeg) errors.push("A matching short leg with the same expiration is required.");
  if (!input.directionalFit) errors.push(`${formatExpressionType(expressionType)} does not fit the current directional bias.`);
  if (metrics.maxGain !== null && metrics.maxGain <= 0) errors.push("Spread reward must be positive.");
  const legWarnings = [
    ...getOptionWarnings(spread?.longLeg, dte, input.eventWarnings).liquidity,
    ...getOptionWarnings(spread?.shortLeg, dte, input.eventWarnings).liquidity
  ];
  const volatilityWarnings = [
    ...getOptionWarnings(spread?.longLeg, dte, input.eventWarnings).volatility,
    ...getOptionWarnings(spread?.shortLeg, dte, input.eventWarnings).volatility
  ];
  const order = spread?.longLeg && spread.shortLeg && metrics.maxLoss !== null
    ? buildMultiLegOrder({
      expressionType,
      symbol: input.symbol,
      legs: [toOptionLeg(spread.longLeg, "buy"), toOptionLeg(spread.shortLeg, "sell")],
      estimatedDebit: metrics.maxLoss,
      maxLoss: metrics.maxLoss,
      maxProfit: metrics.maxGain ?? undefined,
      breakeven: metrics.breakeven ?? undefined,
      requiredCapital: metrics.maxLoss
    })
    : undefined;

  return expression({
    expressionType,
    symbol: input.symbol,
    direction: input.direction,
    confidence: input.confidence,
    maxLoss: metrics.maxLoss,
    maxProfit: metrics.maxGain,
    breakeven: metrics.breakeven,
    requiredCapital,
    riskReward: metrics.maxLoss && metrics.maxGain ? round(metrics.maxGain / metrics.maxLoss, 2) : null,
    liquidityWarnings: [...new Set(legWarnings)],
    volatilityWarnings: [...new Set(volatilityWarnings)],
    earningsWarnings: input.eventWarnings,
    status: errors.length ? "blocked" : "paper_trade_allowed",
    statusReasons: errors,
    rationale: [
      "Debit spreads keep risk defined and reduce premium compared with a single long option.",
      "Reward is capped at the spread width less the debit."
    ],
    dte,
    liquidityScore: averageScore(spread?.longLeg?.liquidityScore, spread?.shortLeg?.liquidityScore),
    paperExecutionMode: OPTIONS_PAPER_MODE,
    multiLegOrder: order,
    optionSelectionDiagnostics: spread?.diagnostics ?? getSingleOptionDiagnostics(input.options, optionType, input.currentPrice, optionType === "call" ? "above" : "below", input.riskSettings),
    timeHorizon: input.timeHorizon
  });
}

function buildCoveredCall(input: {
  symbol: string;
  currentPrice: number | null;
  options: OptionIdea[];
  holdings: HoldingSnapshot;
  maxRisk: number;
  riskSettings: RiskSettings;
  hardBlocked: boolean;
  eventWarnings: string[];
  confidence: number;
  timeHorizon: string;
}): TradeExpression {
  const selection = selectSingleOption(input.options, "call", input.currentPrice, "above", input.riskSettings);
  const call = selection.option;
  const metrics = getCoveredCallMetrics(input.currentPrice, call);
  const dte = call?.daysToExpiration ?? null;
  const errors = getOptionEligibilityErrors({
    option: call,
    price: getOptionPrice(call),
    dte,
    maxLoss: metrics.maxLoss,
    requiredCapital: input.currentPrice ? input.currentPrice * 100 : null,
    input: {
      symbol: input.symbol,
      direction: "neutral",
      currentPrice: input.currentPrice,
      options: input.options,
      maxRisk: input.maxRisk,
      buyingPower: Number.POSITIVE_INFINITY,
      riskSettings: input.riskSettings,
      hardBlocked: input.hardBlocked,
      eventWarnings: input.eventWarnings,
      confidence: input.confidence,
      timeHorizon: input.timeHorizon,
      directionalFit: true
    }
  });
  if (input.holdings.longShares < 100) errors.push("Covered calls require at least 100 long shares of the underlying.");
  const warnings = getOptionWarnings(call, dte, input.eventWarnings);
  const requiredCapital = input.currentPrice ? round(input.currentPrice * 100, 2) : null;
  const order = call && metrics.netCredit !== null && metrics.maxLoss !== null && requiredCapital !== null
    ? buildMultiLegOrder({
      expressionType: "covered_call",
      symbol: input.symbol,
      legs: [toOptionLeg(call, "sell")],
      estimatedCredit: metrics.netCredit,
      maxLoss: metrics.maxLoss,
      maxProfit: metrics.maxGain ?? undefined,
      breakeven: metrics.breakeven ?? undefined,
      requiredCapital
    })
    : undefined;

  return expression({
    expressionType: "covered_call",
    symbol: input.symbol,
    direction: "neutral",
    confidence: input.confidence,
    maxLoss: metrics.maxLoss,
    maxProfit: metrics.maxGain,
    breakeven: metrics.breakeven,
    requiredCapital,
    riskReward: metrics.maxLoss && metrics.maxGain ? round(metrics.maxGain / metrics.maxLoss, 2) : null,
    liquidityWarnings: warnings.liquidity,
    volatilityWarnings: warnings.volatility,
    earningsWarnings: warnings.earnings,
    assignmentWarnings: ["Short call assignment can cap upside or call away shares."],
    status: errors.length ? "blocked" : "paper_trade_allowed",
    statusReasons: errors,
    rationale: [
      "Covered calls fit income research only when the account already owns share coverage.",
      "The position remains exposed to underlying downside."
    ],
    dte,
    liquidityScore: call?.liquidityScore ?? null,
    paperExecutionMode: OPTIONS_PAPER_MODE,
    multiLegOrder: order,
    optionSelectionDiagnostics: selection.diagnostics,
    timeHorizon: input.timeHorizon
  });
}

function buildCashSecuredPut(input: {
  symbol: string;
  currentPrice: number | null;
  options: OptionIdea[];
  cash: number;
  maxRisk: number;
  maxStrategyExposure: number;
  riskSettings: RiskSettings;
  hardBlocked: boolean;
  eventWarnings: string[];
  confidence: number;
  timeHorizon: string;
  directionalFit: boolean;
}): TradeExpression {
  const selection = selectSingleOption(input.options, "put", input.currentPrice, "below", input.riskSettings);
  const put = selection.option;
  const metrics = getCashSecuredPutMetrics(put);
  const dte = put?.daysToExpiration ?? null;
  const requiredCapital = put ? round(put.strikePrice * 100, 2) : null;
  const errors = getOptionEligibilityErrors({
    option: put,
    price: getOptionPrice(put),
    dte,
    maxLoss: metrics.maxLoss,
    requiredCapital,
    input: {
      symbol: input.symbol,
      direction: "neutral",
      currentPrice: input.currentPrice,
      options: input.options,
      maxRisk: input.maxRisk,
      buyingPower: input.cash,
      riskSettings: input.riskSettings,
      hardBlocked: input.hardBlocked,
      eventWarnings: input.eventWarnings,
      confidence: input.confidence,
      timeHorizon: input.timeHorizon,
      directionalFit: input.directionalFit
    }
  });
  if (!input.directionalFit) errors.push("Cash-secured puts require bullish, neutral, or range-bound thesis.");
  if (requiredCapital !== null && requiredCapital > input.cash) errors.push("Cash-secured put collateral exceeds available paper cash.");
  if (requiredCapital !== null && requiredCapital > input.maxStrategyExposure) errors.push("Cash-secured put collateral exceeds strategy exposure cap.");
  const warnings = getOptionWarnings(put, dte, input.eventWarnings);
  const order = put && metrics.netCredit !== null && metrics.maxLoss !== null && requiredCapital !== null
    ? buildMultiLegOrder({
      expressionType: "cash_secured_put",
      symbol: input.symbol,
      legs: [toOptionLeg(put, "sell")],
      estimatedCredit: metrics.netCredit,
      maxLoss: metrics.maxLoss,
      maxProfit: metrics.maxGain ?? undefined,
      breakeven: metrics.breakeven ?? undefined,
      requiredCapital
    })
    : undefined;

  return expression({
    expressionType: "cash_secured_put",
    symbol: input.symbol,
    direction: "neutral",
    confidence: input.confidence,
    maxLoss: metrics.maxLoss,
    maxProfit: metrics.maxGain,
    breakeven: metrics.breakeven,
    requiredCapital,
    riskReward: metrics.maxLoss && metrics.maxGain ? round(metrics.maxGain / metrics.maxLoss, 2) : null,
    liquidityWarnings: warnings.liquidity,
    volatilityWarnings: warnings.volatility,
    earningsWarnings: warnings.earnings,
    assignmentWarnings: ["Short put assignment can require buying 100 shares per contract."],
    status: errors.length ? "blocked" : "paper_trade_allowed",
    statusReasons: errors,
    rationale: [
      "Cash-secured puts fit income or lower-entry research only when assignment cash is reserved.",
      "This is modeled as cash-secured, not a naked put."
    ],
    dte,
    liquidityScore: put?.liquidityScore ?? null,
    paperExecutionMode: OPTIONS_PAPER_MODE,
    multiLegOrder: order,
    optionSelectionDiagnostics: selection.diagnostics,
    timeHorizon: input.timeHorizon
  });
}

interface OptionExpressionInput {
  symbol: string;
  direction: TradeExpressionDirection;
  currentPrice: number | null;
  options: OptionIdea[];
  maxRisk: number;
  buyingPower: number;
  riskSettings: RiskSettings;
  hardBlocked: boolean;
  eventWarnings: string[];
  confidence: number;
  timeHorizon: string;
  directionalFit: boolean;
}

function getOptionEligibilityErrors(input: {
  option?: OptionIdea;
  price: number | null;
  dte: number | null;
  maxLoss: number | null;
  requiredCapital: number | null;
  input: OptionExpressionInput;
}): string[] {
  const errors: string[] = [];
  if (input.input.hardBlocked) errors.push("Global paper-trading blockers must be resolved first.");
  if (!input.option) errors.push("No contract matching the strike, price, and liquidity filters was found.");
  if (input.price === null || input.price <= 0) errors.push("A valid option price is required.");
  if (input.option?.openInterest === null || input.option?.openInterest === undefined) errors.push("Open interest is required for liquidity screening.");
  if ((input.dte ?? 0) <= 0 && input.input.riskSettings.allowZeroDte !== true) errors.push("0DTE options are blocked by default.");
  if ((input.maxLoss ?? 0) <= 0) errors.push("Max loss must be calculable before paper options simulation.");
  if (input.maxLoss !== null && input.maxLoss > input.input.maxRisk) errors.push("Max loss exceeds max per-trade risk.");
  if (input.requiredCapital !== null && input.requiredCapital > input.input.buyingPower) errors.push("Required capital exceeds available paper buying power.");
  if ((input.input.riskSettings.maxOptionsContracts ?? 4) < 1) errors.push("Options contract limit is set below one contract.");
  return errors;
}

function selectSingleOption(
  options: OptionIdea[],
  type: "call" | "put",
  price: number | null,
  moneyness: "above" | "below" = type === "call" ? "above" : "below",
  riskSettings?: RiskSettings
): { option?: OptionIdea; diagnostics: OptionSelectionDiagnostics } {
  const dteWindow = getOptionsDteWindow(riskSettings);
  const eligible = getSingleOptionEligibleSets(options, type, dteWindow);
  const dtePreferred = eligible.openInterestEligible.filter((option) => (option.daysToExpiration ?? 0) >= dteWindow.preferredMin && (option.daysToExpiration ?? 0) <= dteWindow.preferredMax);
  const candidates = dtePreferred.length ? dtePreferred : eligible.openInterestEligible;
  const option = candidates.length
    ? [...candidates].sort((left, right) => {
      const leftMoneyness = getMoneynessDistance(left, price, moneyness);
      const rightMoneyness = getMoneynessDistance(right, price, moneyness);
      const leftDte = Math.abs((left.daysToExpiration ?? 45) - 45);
      const rightDte = Math.abs((right.daysToExpiration ?? 45) - 45);
      return leftMoneyness - rightMoneyness
        || rightLiquidity(right) - rightLiquidity(left)
        || leftDte - rightDte
        || left.strikePrice - right.strikePrice;
    })[0]
    : undefined;

  return {
    option,
    diagnostics: buildSingleOptionDiagnostics({
      options,
      type,
      moneyness,
      eligible,
      candidatesConsidered: candidates.length,
      selected: option,
      dteWindow
    })
  };
}

function getSingleOptionDiagnostics(
  options: OptionIdea[],
  type: "call" | "put",
  price: number | null,
  moneyness: "above" | "below" = type === "call" ? "above" : "below",
  riskSettings?: RiskSettings
): OptionSelectionDiagnostics {
  return selectSingleOption(options, type, price, moneyness, riskSettings).diagnostics;
}

function getSingleOptionEligibleSets(options: OptionIdea[], type: "call" | "put", dteWindow: OptionsDteWindow) {
  const typeMatches = options.filter((option) => option.type === type);
  const dteEligible = typeMatches
    .filter((option) => option.type === type)
    .filter((option) => (option.daysToExpiration ?? 0) >= dteWindow.min && (option.daysToExpiration ?? 0) <= dteWindow.max);
  const priceEligible = dteEligible.filter((option) => getOptionPrice(option) !== null);
  const openInterestEligible = priceEligible.filter((option) => option.openInterest !== null && option.openInterest !== undefined);
  const preferredDteEligible = openInterestEligible.filter((option) => (option.daysToExpiration ?? 0) >= dteWindow.preferredMin && (option.daysToExpiration ?? 0) <= dteWindow.preferredMax);

  return {
    typeMatches,
    dteEligible,
    priceEligible,
    openInterestEligible,
    preferredDteEligible
  };
}

function buildSingleOptionDiagnostics(input: {
  options: OptionIdea[];
  type: "call" | "put";
  moneyness: "above" | "below";
  eligible: ReturnType<typeof getSingleOptionEligibleSets>;
  candidatesConsidered: number;
  selected?: OptionIdea;
  dteWindow: OptionsDteWindow;
}): OptionSelectionDiagnostics {
  const rejectionReasons: string[] = [];
  if (!input.options.length) rejectionReasons.push("No option contracts were loaded for this underlying.");
  if (!input.eligible.typeMatches.length) rejectionReasons.push(`No ${input.type} contracts were loaded.`);
  const dteWindow = input.dteWindow;
  if (input.eligible.typeMatches.length && !input.eligible.dteEligible.length) rejectionReasons.push(`No contracts were inside the broad ${dteWindow.min}-${dteWindow.max} DTE fallback window.`);
  if (input.eligible.dteEligible.length && !input.eligible.priceEligible.length) rejectionReasons.push("No DTE-eligible contracts had valid mid, last, or close pricing.");
  if (input.eligible.priceEligible.length && !input.eligible.openInterestEligible.length) rejectionReasons.push("No priced contracts had open-interest data for liquidity screening.");
  if (input.eligible.openInterestEligible.length && !input.eligible.preferredDteEligible.length) {
    rejectionReasons.push(`No priced/liquid contracts were in the preferred ${dteWindow.preferredMin}-${dteWindow.preferredMax} DTE window; using the broader ${dteWindow.min}-${dteWindow.max} DTE pool.`);
  }

  return {
    optionType: input.type,
    moneyness: input.moneyness,
    totalContracts: input.options.length,
    typeMatches: input.eligible.typeMatches.length,
    dteEligible: input.eligible.dteEligible.length,
    priceEligible: input.eligible.priceEligible.length,
    openInterestEligible: input.eligible.openInterestEligible.length,
    preferredDteEligible: input.eligible.preferredDteEligible.length,
    dteWindow,
    candidatesConsidered: input.candidatesConsidered,
    selectedSymbol: input.selected?.symbol,
    selectedExpiration: input.selected?.expirationDate,
    selectedStrike: input.selected?.strikePrice,
    rejectionReasons
  };
}

type OptionsDteWindow = {
  min: number;
  max: number;
  preferredMin: number;
  preferredMax: number;
};

function getOptionsDteWindow(riskSettings?: RiskSettings): OptionsDteWindow {
  const min = riskSettings?.allowZeroDte === true ? 0 : 1;
  const max = Math.max(365, Math.round(riskSettings?.maxOptionsDte ?? 365));
  const preferredMin = Math.max(min, Math.round(riskSettings?.preferredOptionsDteMin ?? 14));
  const preferredMax = Math.min(max, Math.max(preferredMin + 1, Math.round(riskSettings?.preferredOptionsDteMax ?? 60)));
  return {
    min,
    max,
    preferredMin,
    preferredMax
  };
}

function selectDebitSpread(
  options: OptionIdea[],
  type: "call" | "put",
  price: number | null,
  riskSettings?: RiskSettings
): { longLeg?: OptionIdea; shortLeg?: OptionIdea; diagnostics: OptionSelectionDiagnostics } {
  const longSelection = selectSingleOption(options, type, price, type === "call" ? "above" : "below", riskSettings);
  const longLeg = longSelection.option;
  if (!longLeg) return { diagnostics: longSelection.diagnostics };
  const sameExpiry = options
    .filter((option) => option.type === type && option.expirationDate === longLeg.expirationDate && option.symbol !== longLeg.symbol)
    .filter((option) => getOptionPrice(option) !== null && option.openInterest !== null && option.openInterest !== undefined);
  const shortCandidates = type === "call"
    ? sameExpiry.filter((option) => option.strikePrice > longLeg.strikePrice)
    : sameExpiry.filter((option) => option.strikePrice < longLeg.strikePrice);
  const shortLeg = shortCandidates.sort((left, right) => {
    const widthLeft = Math.abs(left.strikePrice - longLeg.strikePrice);
    const widthRight = Math.abs(right.strikePrice - longLeg.strikePrice);
    return widthLeft - widthRight || rightLiquidity(right) - rightLiquidity(left);
  })[0];
  return {
    longLeg,
    shortLeg,
    diagnostics: {
      ...longSelection.diagnostics,
      rejectionReasons: shortLeg
        ? longSelection.diagnostics.rejectionReasons
        : [...longSelection.diagnostics.rejectionReasons, "No same-expiration short leg passed pricing, open-interest, and strike-side filters."],
      spread: {
        sameExpirationContracts: options.filter((option) => option.type === type && option.expirationDate === longLeg.expirationDate && option.symbol !== longLeg.symbol).length,
        priceAndOpenInterestEligible: sameExpiry.length,
        strikeSideEligible: shortCandidates.length,
        selectedShortSymbol: shortLeg?.symbol
      }
    }
  };
}

function getOptionWarnings(option: OptionIdea | undefined, dte: number | null, earningsWarnings: string[]) {
  const liquidity: string[] = [];
  const volatility: string[] = [];
  if (!option) return { liquidity: ["No contract selected."], volatility, earnings: earningsWarnings };
  if (option.liquidityWarning) liquidity.push(option.liquidityWarning);
  if (option.bidPrice === null || option.bidPrice === undefined || option.askPrice === null || option.askPrice === undefined) {
    liquidity.push("Bid/ask quote unavailable; simulation uses last or close pricing.");
  }
  if ((option.spreadWidthPct ?? 0) > 0.2) liquidity.push("Bid/ask spread is wider than 20% of mid.");
  if ((option.openInterest ?? 0) < 100) liquidity.push("Open interest is below the default liquidity preference.");
  if ((dte ?? 0) > 0 && (dte ?? 0) < 21) volatility.push("Short DTE increases theta decay and gap risk.");
  if ((option.theta ?? 0) < -0.1) volatility.push("Theta decay is high for this contract.");
  if ((option.impliedVolatility ?? 0) > 0.8) volatility.push("Implied volatility is elevated.");
  return { liquidity: [...new Set(liquidity)], volatility: [...new Set(volatility)], earnings: earningsWarnings };
}

function buildMultiLegOrder(input: {
  expressionType: TradeExpressionType;
  symbol: string;
  legs: OptionLeg[];
  estimatedDebit?: number;
  estimatedCredit?: number;
  maxLoss: number;
  maxProfit?: number;
  breakeven?: number;
  requiredCapital: number;
}): MultiLegPaperOrder {
  return {
    expressionType: input.expressionType,
    underlyingSymbol: input.symbol,
    legs: input.legs,
    estimatedDebit: input.estimatedDebit,
    estimatedCredit: input.estimatedCredit,
    maxLoss: input.maxLoss,
    maxProfit: input.maxProfit,
    breakeven: input.breakeven,
    requiredCapital: input.requiredCapital,
    paperExecutionMode: OPTIONS_PAPER_MODE
  };
}

function toOptionLeg(option: OptionIdea, side: "buy" | "sell"): OptionLeg {
  return {
    optionSymbol: option.symbol,
    underlyingSymbol: option.underlyingSymbol,
    optionType: option.type,
    side,
    quantity: 1,
    strike: option.strikePrice,
    expiration: option.expirationDate,
    limitPrice: getOptionPrice(option) ?? undefined,
    estimatedMid: getOptionPrice(option) ?? undefined,
    bid: option.bidPrice ?? undefined,
    ask: option.askPrice ?? undefined,
    last: option.lastPrice ?? option.closePrice ?? undefined,
    delta: option.delta ?? undefined,
    theta: option.theta ?? undefined,
    vega: option.vega ?? undefined,
    impliedVolatility: option.impliedVolatility ?? undefined,
    openInterest: option.openInterest,
    volume: option.volume,
    liquidityScore: option.liquidityScore
  };
}

function expression(input: {
  expressionType: TradeExpressionType;
  symbol: string;
  direction: TradeExpressionDirection;
  confidence: number;
  maxLoss: number | null;
  maxProfit?: number | null;
  breakeven?: number | null;
  requiredCapital: number | null;
  riskReward: number | null;
  status: TradeExpressionStatus;
  statusReasons: string[];
  rationale: string[];
  liquidityWarnings?: string[];
  volatilityWarnings?: string[];
  earningsWarnings?: string[];
  assignmentWarnings?: string[];
  dte?: number | null;
  liquidityScore?: number | null;
  paperExecutionMode?: PaperExecutionMode;
  order?: PaperOrderRequest;
  multiLegOrder?: MultiLegPaperOrder;
  optionSelectionDiagnostics?: OptionSelectionDiagnostics;
  timeHorizon: string;
}): TradeExpression {
  return {
    id: `${input.symbol}-${input.expressionType}`,
    expressionType: input.expressionType,
    underlyingSymbol: input.symbol,
    direction: input.direction,
    timeHorizon: input.timeHorizon,
    confidence: clampConfidence(input.confidence),
    maxLoss: input.maxLoss,
    maxProfit: input.maxProfit,
    breakeven: input.breakeven,
    requiredCapital: input.requiredCapital,
    liquidityWarnings: input.liquidityWarnings ?? [],
    volatilityWarnings: input.volatilityWarnings ?? [],
    earningsWarnings: input.earningsWarnings ?? [],
    assignmentWarnings: input.assignmentWarnings ?? [],
    riskReward: input.riskReward,
    rationale: input.rationale,
    alternatives: [],
    status: input.status,
    statusReasons: input.statusReasons,
    dte: input.dte,
    liquidityScore: input.liquidityScore,
    paperExecutionMode: input.paperExecutionMode,
    order: input.order,
    multiLegOrder: input.multiLegOrder,
    optionSelectionDiagnostics: input.optionSelectionDiagnostics
  };
}

function researchOnlyExpression(input: {
  expressionType: TradeExpressionType;
  symbol: string;
  direction: TradeExpressionDirection;
  confidence: number;
  rationale: string[];
  warnings: string[];
}): TradeExpression {
  return expression({
    expressionType: input.expressionType,
    symbol: input.symbol,
    direction: input.direction,
    confidence: input.confidence,
    maxLoss: null,
    maxProfit: null,
    requiredCapital: null,
    riskReward: null,
    status: "research_only",
    statusReasons: ["Research-only strategy in this phase."],
    rationale: input.rationale,
    assignmentWarnings: input.warnings,
    paperExecutionMode: "research_only",
    timeHorizon: "Research only"
  });
}

function buildNoTradeExpression(symbol: string, snapshot: SignalSnapshot, riskWarnings: string[], hardBlocked: boolean): TradeExpression {
  return expression({
    expressionType: "no_trade",
    symbol,
    direction: "neutral",
    confidence: hardBlocked || snapshot.score < 60 ? 85 : 45,
    maxLoss: 0,
    maxProfit: 0,
    breakeven: null,
    requiredCapital: 0,
    riskReward: null,
    status: "research_only",
    statusReasons: hardBlocked ? riskWarnings : ["No-trade is available when edge, risk, or data quality is not strong enough."],
    rationale: [
      "No trade preserves capital when the setup is unclear, blocked, event-heavy, or missing required data.",
      "Waiting is a valid trade expression."
    ],
    paperExecutionMode: "research_only",
    timeHorizon: "Wait for a cleaner setup"
  });
}

function rankExpressions(expressions: TradeExpression[], preference: TradeExpressionPreference, snapshot: SignalSnapshot): TradeExpression[] {
  return [...expressions].sort((left, right) => getExpressionScore(right, preference, snapshot) - getExpressionScore(left, preference, snapshot));
}

function chooseRecommendation(expressions: TradeExpression[], snapshot: SignalSnapshot, hardBlocked: boolean): TradeExpression {
  const noTrade = expressions.find((candidate) => candidate.expressionType === "no_trade") ?? expressions[0];
  const directionalConfidence = isBearish(snapshot) ? 100 - snapshot.score : snapshot.score;
  if (hardBlocked || snapshot.bias === "caution" || directionalConfidence < 55) return noTrade;
  return expressions.find((candidate) => candidate.status === "paper_trade_allowed") ?? noTrade;
}

function getExpressionScore(expression: TradeExpression, preference: TradeExpressionPreference, snapshot: SignalSnapshot): number {
  if (expression.expressionType === "no_trade") return snapshot.score < 60 || expression.status === "blocked" ? 90 : 10;
  const statusScore = expression.status === "paper_trade_allowed" ? 40 : expression.status === "research_only" ? 10 : -50;
  const preferenceScore = getPreferenceScore(expression.expressionType, preference);
  const warningPenalty = expression.liquidityWarnings.length * 3 + expression.volatilityWarnings.length * 2 + expression.assignmentWarnings.length * 2;
  return statusScore + preferenceScore + expression.confidence * 0.4 + (expression.riskReward ?? 0) * 4 - warningPenalty;
}

function getPreferenceScore(type: TradeExpressionType, preference: TradeExpressionPreference): number {
  const table: Record<TradeExpressionPreference, Partial<Record<TradeExpressionType, number>>> = {
    simple: { long_equity: 28, short_equity: 22, no_trade: 10 },
    defined_risk: { bull_call_debit_spread: 30, bear_put_debit_spread: 30, long_call: 20, long_put: 20 },
    income: { covered_call: 30, cash_secured_put: 28, credit_spread_research: 10 },
    leverage: { long_call: 30, long_put: 30, bull_call_debit_spread: 18, bear_put_debit_spread: 18 },
    capital_efficient: { bull_call_debit_spread: 30, bear_put_debit_spread: 30, long_call: 18, long_put: 18 }
  };
  return table[preference][type] ?? 0;
}

function getGlobalRiskWarnings(input: TradeExpressionEngineInput, equity: number, now: Date): string[] {
  const warnings: string[] = [];
  if (input.riskSettings.killSwitchEnabled) warnings.push("Kill switch is enabled; all paper order creation is blocked.");
  if (!input.snapshot.lastPrice) warnings.push("A current underlying price is required.");
  const signalAgeMinutes = (now.getTime() - new Date(input.snapshot.asOf).getTime()) / 60000;
  if (!Number.isFinite(signalAgeMinutes) || signalAgeMinutes > input.riskSettings.maxDataAgeMinutes) {
    warnings.push(`Signal data is older than ${input.riskSettings.maxDataAgeMinutes} minutes.`);
  }
  if ((input.snapshot.riskDollars ?? 0) > equity * input.riskSettings.maxRiskPerTradePct) {
    warnings.push("Underlying plan risk exceeds max per-trade risk.");
  }
  if (input.currentHoldings.length >= (input.riskSettings.maxOpenPositions ?? 12)) {
    warnings.push("Open position count is at or above the configured limit.");
  }
  warnings.push(...getEarningsWarnings(input.earningsDate, input.riskSettings, now));
  return [...new Set(warnings)];
}

function getEarningsWarnings(earningsDate: string | undefined, riskSettings: RiskSettings, now: Date): string[] {
  if (!earningsDate) return [];
  const date = new Date(earningsDate);
  if (!Number.isFinite(date.getTime())) return [];
  const days = (date.getTime() - now.getTime()) / 86400000;
  if (days >= 0 && days <= riskSettings.earningsWindowDays) {
    return [`Earnings are within ${riskSettings.earningsWindowDays} days; event risk must be acknowledged.`];
  }
  return [];
}

function getHoldingSnapshot(positions: unknown[], symbol: string): HoldingSnapshot {
  let longShares = 0;
  let shortShares = 0;
  for (const position of positions) {
    if (!position || typeof position !== "object") continue;
    const rawSymbol = (position as { symbol?: unknown }).symbol;
    if (typeof rawSymbol !== "string" || rawSymbol.toUpperCase() !== symbol) continue;
    const qty = Math.abs(Number((position as { qty?: unknown; quantity?: unknown }).qty ?? (position as { quantity?: unknown }).quantity ?? 0));
    const side = String((position as { side?: unknown }).side ?? "").toLowerCase();
    if (side === "short" || Number((position as { qty?: unknown }).qty ?? 0) < 0) shortShares += qty;
    else longShares += qty;
  }
  return { longShares, shortShares };
}

interface HoldingSnapshot {
  longShares: number;
  shortShares: number;
}

function getDefaultPreference(snapshot: SignalSnapshot): TradeExpressionPreference {
  if (snapshot.bias === "bearish") return "defined_risk";
  if (snapshot.trend === "range" || snapshot.bias === "neutral") return "income";
  return "simple";
}

function getTimeHorizon(snapshot: SignalSnapshot): string {
  if (snapshot.atr14 && snapshot.lastPrice && snapshot.atr14 / snapshot.lastPrice > 0.04) return "Short swing";
  return "Swing";
}

function isBullish(snapshot: SignalSnapshot): boolean {
  return snapshot.bias === "bullish" || snapshot.trend === "uptrend";
}

function isBearish(snapshot: SignalSnapshot): boolean {
  return snapshot.bias === "bearish" || snapshot.trend === "downtrend";
}

function getIncomeConfidence(snapshot: SignalSnapshot): number {
  if (snapshot.trend === "range" || snapshot.bias === "neutral") return 72;
  if (snapshot.bias === "bullish") return 62;
  return 45;
}

function getMoneynessDistance(option: OptionIdea, price: number | null, side: "above" | "below"): number {
  if (!price) return 0;
  const wrongSidePenalty = side === "above" && option.strikePrice < price ? 1000 : side === "below" && option.strikePrice > price ? 1000 : 0;
  return wrongSidePenalty + Math.abs(option.strikePrice - price);
}

function rightLiquidity(option: OptionIdea): number {
  return option.liquidityScore ?? 0;
}

function averageScore(left?: number | null, right?: number | null): number | null {
  const values = [left, right].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function getAccountNumber(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatExpressionType(type: TradeExpressionType): string {
  return type.replaceAll("_", " ");
}
