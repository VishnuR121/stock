import { z } from "zod";
import type { PaperOrderRequest, PaperOrderValidationResult, RiskProfile } from "../src/shared/types";
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
