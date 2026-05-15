import { z } from "zod";
import type { MultiLegPaperOrderRequest, MultiLegPaperOrderValidationResult, PaperOrderRequest, PaperOrderValidationResult, RiskProfile, RiskSettings, TradeExpressionType } from "../src/shared/types";
import { calculateOrderLevelDistances, checkDayOrderTargetRealism, TRADE_HORIZONS } from "../src/shared/orderHorizon";
import { round } from "./indicators";

const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, "Use an equity or ETF ticker symbol, not an option contract.");

export const watchlistItemSchema = z.object({
  symbol: symbolSchema,
  notes: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).default([])
});

export const paperOrderSchema = z
  .object({
    symbol: symbolSchema,
    side: z.enum(["buy", "sell"]).default("buy"),
    orderType: z.enum(["market", "limit"]),
    quantity: z.number().positive().max(100000).optional(),
    notional: z.number().positive().max(10_000_000).optional(),
    limitPrice: z.number().positive().optional(),
    stopLossPrice: z.number().positive(),
    takeProfitPrice: z.number().positive(),
    timeInForce: z.enum(["day", "gtc"]),
    horizon: z.enum(TRADE_HORIZONS).default("intraday"),
    earningsChecked: z.boolean(),
    confirmedPaperOnly: z.boolean(),
    acceptedRisk: z.boolean(),
    sourcePlanId: z.string().max(120).optional(),
    sourceSignalAsOf: z.string().max(80).optional(),
    sourceAnalysisId: z.string().max(120).optional(),
    sourceProposalId: z.string().max(120).optional(),
    followedPlan: z.boolean().optional()
  })
  .refine((order) => Boolean(order.quantity) !== Boolean(order.notional), {
    message: "Provide either quantity or notional, but not both.",
    path: ["quantity"]
  })
  .refine((order) => order.orderType === "market" || Boolean(order.limitPrice), {
    message: "Limit orders require a limit price.",
    path: ["limitPrice"]
  });

const expressionTypes: [TradeExpressionType, ...TradeExpressionType[]] = [
  "long_equity",
  "short_equity",
  "long_call",
  "long_put",
  "covered_call",
  "cash_secured_put",
  "bull_call_debit_spread",
  "bear_put_debit_spread",
  "credit_spread_research",
  "iron_condor_research",
  "no_trade"
];

export const optionLegSchema = z.object({
  optionSymbol: z.string().trim().min(8).max(32),
  underlyingSymbol: symbolSchema,
  optionType: z.enum(["call", "put"]),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive().max(100),
  strike: z.number().positive(),
  expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expiration must be YYYY-MM-DD."),
  limitPrice: z.number().positive().optional(),
  estimatedMid: z.number().positive().optional(),
  bid: z.number().nonnegative().optional(),
  ask: z.number().nonnegative().optional(),
  last: z.number().positive().optional(),
  delta: z.number().optional(),
  theta: z.number().optional(),
  vega: z.number().optional(),
  impliedVolatility: z.number().nonnegative().optional(),
  openInterest: z.number().nonnegative().nullable().optional(),
  volume: z.number().nonnegative().nullable().optional(),
  liquidityScore: z.number().min(0).max(100).nullable().optional()
});

export const multiLegPaperOrderSchema = z.object({
  expressionType: z.enum(expressionTypes),
  underlyingSymbol: symbolSchema,
  legs: z.array(optionLegSchema).min(1).max(4),
  estimatedDebit: z.number().nonnegative().optional(),
  estimatedCredit: z.number().nonnegative().optional(),
  maxLoss: z.number().positive(),
  maxProfit: z.number().nonnegative().optional(),
  breakeven: z.number().positive().optional(),
  requiredCapital: z.number().nonnegative(),
  paperExecutionMode: z.enum(["broker_paper", "internal_simulation", "research_only"]),
  timeHorizon: z.string().min(3).max(80),
  earningsChecked: z.boolean(),
  confirmedPaperOnly: z.boolean(),
  acceptedRisk: z.boolean(),
  maxLossAcknowledged: z.boolean(),
  paperSimulationAcknowledged: z.boolean(),
  noLiveEndpointAcknowledged: z.boolean(),
  sourcePlanId: z.string().max(120).optional(),
  sourceSignalAsOf: z.string().max(80).optional(),
  sourceAnalysisId: z.string().max(120).optional(),
  sourceExpressionId: z.string().max(120).optional(),
  followedPlan: z.boolean().optional()
});

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function isValidEquitySymbol(symbol: string): boolean {
  return symbolSchema.safeParse(symbol).success;
}

export function validatePaperOrder(
  input: unknown,
  riskProfile: RiskProfile,
  referencePrice?: number | null,
  options: { now?: Date } = {}
): PaperOrderValidationResult & { order?: PaperOrderRequest } {
  const parsed = paperOrderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
      warnings: [],
      estimatedNotional: null,
      estimatedRisk: null
    };
  }

  const order = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const entryPrice = order.orderType === "limit" ? order.limitPrice : referencePrice;

  if (!order.confirmedPaperOnly) errors.push("Confirm this is for Alpaca paper trading only.");
  if (!order.acceptedRisk) errors.push("Confirm that you accept the paper-trade risk plan.");
  if (!order.earningsChecked) errors.push("Confirm that you checked earnings or event timing before submitting.");
  if (!entryPrice) errors.push("A current price is required for market order validation.");
  if (entryPrice && order.side === "buy" && order.stopLossPrice >= entryPrice) errors.push("Stop loss must be below the estimated entry price for a long order.");
  if (entryPrice && order.side === "buy" && order.takeProfitPrice <= entryPrice) errors.push("Take profit must be above the estimated entry price for a long order.");
  if (entryPrice && order.side === "sell" && order.stopLossPrice <= entryPrice) errors.push("Stop loss must be above the estimated entry price for a short order.");
  if (entryPrice && order.side === "sell" && order.takeProfitPrice >= entryPrice) errors.push("Take profit must be below the estimated entry price for a short order.");
  if (order.orderType === "limit" && order.limitPrice && order.limitPrice <= 0) errors.push("Limit price must be positive.");

  const estimatedNotional = getEstimatedNotional(order, entryPrice);
  const estimatedRisk = getEstimatedRisk(order, entryPrice);
  const maxPosition = riskProfile.accountEquity * riskProfile.maxPositionPct;
  const maxRisk = riskProfile.accountEquity * riskProfile.maxRiskPerTradePct;

  if (estimatedNotional !== null && estimatedNotional > maxPosition) {
    errors.push(`Estimated position exceeds conservative max notional of ${round(maxPosition, 2)}.`);
  }

  if (estimatedRisk !== null && estimatedRisk > maxRisk) {
    errors.push(`Estimated risk exceeds max per-trade risk of ${round(maxRisk, 2)}.`);
  }

  if (entryPrice) {
    const reward = order.side === "sell" ? entryPrice - order.takeProfitPrice : order.takeProfitPrice - entryPrice;
    const risk = order.side === "sell" ? order.stopLossPrice - entryPrice : entryPrice - order.stopLossPrice;
    const riskReward = risk > 0 ? reward / risk : 0;
    if (riskReward < riskProfile.minRiskReward) {
      warnings.push(`Risk/reward is below ${riskProfile.minRiskReward}:1.`);
    }
  }

  const levelDistances = calculateOrderLevelDistances(order, entryPrice);
  const targetRealism = checkDayOrderTargetRealism({
    order,
    referencePrice: entryPrice,
    now: options.now
  });

  if (!targetRealism.ok && targetRealism.message) {
    errors.push(targetRealism.message);
  } else if (targetRealism.severity === "warning" && targetRealism.message) {
    warnings.push(targetRealism.message);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    estimatedNotional,
    estimatedRisk,
    levelDistances,
    targetRealism,
    order
  };
}

export function validateMultiLegPaperOrder(
  input: unknown,
  riskProfile: RiskProfile,
  riskSettings: RiskSettings,
  options: {
    buyingPower?: number | null;
    alpacaPaperOnly?: boolean;
    now?: Date;
    openPaperPositionCount?: number;
    existingOptionsContracts?: number;
    existingUnderlyingRequiredCapital?: number;
  } = {}
): MultiLegPaperOrderValidationResult {
  const parsed = multiLegPaperOrderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
      warnings: [],
      estimatedNotional: null,
      estimatedRisk: null
    };
  }

  const order = parsed.data as MultiLegPaperOrderRequest;
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = options.now ?? new Date();
  const buyingPower = typeof options.buyingPower === "number" && Number.isFinite(options.buyingPower)
    ? options.buyingPower
    : riskProfile.accountEquity;
  const maxRisk = riskProfile.accountEquity * riskProfile.maxRiskPerTradePct;
  const maxStrategyExposure = riskProfile.accountEquity * (riskSettings.maxStrategyExposurePct ?? riskProfile.maxPositionPct);
  const maxContracts = riskSettings.maxOptionsContracts ?? 4;
  const maxOpenPositions = riskSettings.maxOpenPositions ?? 12;
  const openPaperPositionCount = Math.max(0, options.openPaperPositionCount ?? 0);
  const existingOptionsContracts = Math.max(0, options.existingOptionsContracts ?? 0);
  const existingUnderlyingRequiredCapital = Math.max(0, options.existingUnderlyingRequiredCapital ?? 0);
  const totalContracts = getTotalContracts(order);

  if (riskSettings.killSwitchEnabled) errors.push("Paper order entry is disabled because the kill switch is enabled.");
  if (options.alpacaPaperOnly === false) errors.push("Live Alpaca endpoints are blocked. Use the paper endpoint before paper options simulation.");
  if (!order.confirmedPaperOnly) errors.push("Confirm this is paper-only options research.");
  if (!order.acceptedRisk) errors.push("Confirm that you accept the defined max-loss risk plan.");
  if (!order.earningsChecked) errors.push("Confirm that you checked earnings or event timing before submitting.");
  if (!order.maxLossAcknowledged) errors.push("Acknowledge the calculated max loss before creating a paper options entry.");
  if (!order.paperSimulationAcknowledged) errors.push("Acknowledge that options paper fills are internal simulations and may differ from live fills.");
  if (!order.noLiveEndpointAcknowledged) errors.push("Acknowledge that no live endpoint or live options order is being used.");
  if (order.paperExecutionMode === "broker_paper") errors.push("Broker-paper options submission is not implemented yet; use internal simulation or research-only.");
  if (order.paperExecutionMode === "research_only") errors.push("Research-only expressions cannot create a paper trade.");
  if (!isAllowedOptionsExpression(order.expressionType)) errors.push("This expression type is not enabled for options paper simulation.");
  if (order.maxLoss > maxRisk) errors.push(`Estimated max loss exceeds max per-trade risk of ${round(maxRisk, 2)}.`);
  if (order.requiredCapital > maxStrategyExposure) errors.push(`Required capital exceeds strategy exposure cap of ${round(maxStrategyExposure, 2)}.`);
  if (existingUnderlyingRequiredCapital + order.requiredCapital > maxStrategyExposure) {
    errors.push(`Open ${order.underlyingSymbol} options exposure plus this order exceeds strategy exposure cap of ${round(maxStrategyExposure, 2)}.`);
  }
  if (order.requiredCapital > buyingPower) errors.push("Required capital exceeds available paper buying power.");
  if (totalContracts > maxContracts) errors.push(`Order exceeds max options contract limit of ${maxContracts}.`);
  if (existingOptionsContracts + totalContracts > maxContracts) {
    errors.push(`Open options simulations plus this order exceed max options contract limit of ${maxContracts}.`);
  }
  if (openPaperPositionCount + 1 > maxOpenPositions) {
    errors.push(`Open paper positions plus this order exceed max open positions limit of ${maxOpenPositions}.`);
  }
  if (!hasDefinedRisk(order)) errors.push("Undefined-risk or naked options structures are blocked.");

  for (const leg of order.legs) {
    const dte = getLegDte(leg.expiration, now);
    if (dte <= 0 && riskSettings.allowZeroDte !== true) errors.push("0DTE options are blocked by default.");
    if (!leg.limitPrice && !leg.estimatedMid && !leg.last) errors.push(`Missing price for ${leg.optionSymbol}.`);
    if (leg.openInterest === null || leg.openInterest === undefined) errors.push(`Open interest is required for ${leg.optionSymbol}.`);
    if ((leg.openInterest ?? 0) < 100) warnings.push(`${leg.optionSymbol} has low open interest.`);
    if (leg.volume !== null && leg.volume !== undefined && leg.volume < 10) warnings.push(`${leg.optionSymbol} has low option volume.`);
    if (leg.bid !== undefined && leg.ask !== undefined && leg.bid > 0 && leg.ask > leg.bid) {
      const mid = (leg.bid + leg.ask) / 2;
      if ((leg.ask - leg.bid) / mid > 0.2) warnings.push(`${leg.optionSymbol} has a wide bid/ask spread.`);
    } else {
      warnings.push(`${leg.optionSymbol} is missing a complete bid/ask quote; simulation uses last or mid pricing.`);
    }
    if (leg.side === "sell") warnings.push(`${leg.optionSymbol} has assignment risk because it is a short option leg.`);
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    estimatedNotional: round(order.requiredCapital, 2),
    estimatedRisk: round(order.maxLoss, 2),
    order
  };
}

function getEstimatedNotional(order: PaperOrderRequest, entryPrice?: number | null): number | null {
  if (order.notional) return round(order.notional, 2);
  if (order.quantity && entryPrice) return round(order.quantity * entryPrice, 2);
  return null;
}

function getEstimatedRisk(order: PaperOrderRequest, entryPrice?: number | null): number | null {
  if (!entryPrice) return null;
  const riskPerShare = order.side === "sell" ? order.stopLossPrice - entryPrice : entryPrice - order.stopLossPrice;
  if (riskPerShare <= 0) return null;
  if (order.quantity) return round(order.quantity * riskPerShare, 2);
  if (order.notional) return round((order.notional / entryPrice) * riskPerShare, 2);
  return null;
}

function isAllowedOptionsExpression(expressionType: TradeExpressionType): boolean {
  return [
    "long_call",
    "long_put",
    "covered_call",
    "cash_secured_put",
    "bull_call_debit_spread",
    "bear_put_debit_spread"
  ].includes(expressionType);
}

function getTotalContracts(order: MultiLegPaperOrderRequest): number {
  return order.legs.reduce((sum, leg) => sum + leg.quantity, 0);
}

function getLegDte(expiration: string, now: Date): number {
  if (expiration === now.toISOString().slice(0, 10)) return 0;
  const expirationTime = new Date(`${expiration}T21:00:00.000Z`).getTime();
  if (!Number.isFinite(expirationTime)) return 0;
  return Math.ceil((expirationTime - now.getTime()) / 86400000);
}

function hasDefinedRisk(order: MultiLegPaperOrderRequest): boolean {
  if (order.expressionType === "long_call" || order.expressionType === "long_put") {
    return order.legs.length === 1 && order.legs[0].side === "buy" && order.maxLoss > 0;
  }

  if (order.expressionType === "bull_call_debit_spread") {
    const longCall = order.legs.find((leg) => leg.optionType === "call" && leg.side === "buy");
    const shortCall = order.legs.find((leg) => leg.optionType === "call" && leg.side === "sell");
    return Boolean(longCall && shortCall && longCall.expiration === shortCall.expiration && longCall.strike < shortCall.strike && order.maxLoss > 0);
  }

  if (order.expressionType === "bear_put_debit_spread") {
    const longPut = order.legs.find((leg) => leg.optionType === "put" && leg.side === "buy");
    const shortPut = order.legs.find((leg) => leg.optionType === "put" && leg.side === "sell");
    return Boolean(longPut && shortPut && longPut.expiration === shortPut.expiration && longPut.strike > shortPut.strike && order.maxLoss > 0);
  }

  if (order.expressionType === "covered_call") {
    return order.legs.length === 1 && order.legs[0].optionType === "call" && order.legs[0].side === "sell" && order.requiredCapital > 0;
  }

  if (order.expressionType === "cash_secured_put") {
    return order.legs.length === 1 && order.legs[0].optionType === "put" && order.legs[0].side === "sell" && order.requiredCapital >= order.legs[0].strike * 100;
  }

  return false;
}
