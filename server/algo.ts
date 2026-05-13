import type {
  AlgoTradeProposal,
  AnalysisRun,
  BrokerAccountSnapshot,
  OptionOrderRequest,
  PaperOrderRequest,
  PaperOrderValidationResult,
  RiskSettings,
  StrategyCandidate
} from "../src/shared/types";
import {
  checkDayOrderTargetRealism,
  deriveTradeHorizon,
  expectedHoldingPeriod,
  selectDefaultTimeInForce
} from "../src/shared/orderHorizon";
import { round } from "./indicators";
import { validatePaperOrder } from "./validation";

interface BuildAlgoProposalInput {
  analysisRun: AnalysisRun;
  account: BrokerAccountSnapshot | { equity?: number | null };
  riskSettings: RiskSettings;
  referencePrice?: number | null;
  now?: Date;
}

const PROPOSAL_LIMIT = 5;

export function buildAlgoTradeProposals(input: BuildAlgoProposalInput): AlgoTradeProposal[] {
  const hardBlocked = input.analysisRun.safetyBlockers.some((blocker) => blocker.severity === "blocker");
  const selected = selectStrategies(input.analysisRun.strategyCandidates);
  const now = new Date().toISOString();
  const proposals = selected.map((strategy, index) => {
    const horizon = deriveTradeHorizon({ strategyKind: strategy.kind, signal: input.analysisRun.snapshot });
    const holdingPeriod = expectedHoldingPeriod(horizon);
    const referencePrice = input.referencePrice ?? input.analysisRun.snapshot.lastPrice;
    const order = buildPaperOrder(strategy, input, horizon);
    const optionOrder = buildOptionOrder(strategy, input, horizon);
    const validation = order
      ? validatePaperOrder(
          { ...order, earningsChecked: true, confirmedPaperOnly: true, acceptedRisk: true },
          {
            accountEquity: input.account.equity ?? 100000,
            maxRiskPerTradePct: input.riskSettings.maxRiskPerTradePct,
            maxPositionPct: input.riskSettings.maxPositionPct,
            maxDailyLossPct: input.riskSettings.maxDailyLossPct,
            minRiskReward: input.riskSettings.minRiskReward
          },
          referencePrice,
          { now: input.now }
        )
      : undefined;
    const targetRealism = order
      ? checkDayOrderTargetRealism({ order, referencePrice, now: input.now })
      : undefined;
    const executable = Boolean(
      !hardBlocked &&
      ((order && validation?.ok && (strategy.kind === "long_stock" || strategy.kind === "short_stock")) ||
        (optionOrder && (strategy.kind === "long_call" || strategy.kind === "long_put")))
    );

    return {
      id: `algo-${input.analysisRun.symbol}-${Date.now()}-${index}`,
      createdAt: now,
      updatedAt: now,
      symbol: input.analysisRun.symbol,
      sourceAnalysisId: input.analysisRun.id,
      signalAsOf: input.analysisRun.signalAsOf,
      strategyKind: strategy.kind,
      strategyTitle: strategy.title,
      direction: strategy.direction,
      status: hardBlocked ? "blocked" : "queued",
      executionType: getExecutionType(strategy, order, optionOrder),
      horizon,
      expectedHoldingPeriod: holdingPeriod,
      executable,
      score: strategy.score,
      summary: strategy.summary,
      setup: strategy.setup,
      riskNotes: strategy.riskNotes,
      warnings: buildWarnings(strategy, validation, hardBlocked),
      order,
      optionOrder,
      validation,
      targetRealism
    } satisfies AlgoTradeProposal;
  });

  if (proposals.length) return proposals;

  const snapshot = input.analysisRun.snapshot;
  const horizon = deriveTradeHorizon({ signal: snapshot });
  return [{
    id: `algo-${input.analysisRun.symbol}-${Date.now()}-watch`,
    createdAt: now,
    updatedAt: now,
    symbol: input.analysisRun.symbol,
    sourceAnalysisId: input.analysisRun.id,
    signalAsOf: input.analysisRun.signalAsOf,
    strategyKind: "watch_only",
    strategyTitle: "Watch only",
    direction: "neutral",
    status: "blocked",
    executionType: "research_only",
    horizon,
    expectedHoldingPeriod: expectedHoldingPeriod(horizon),
    executable: false,
    score: snapshot.score,
    summary: "The algo did not find a trade candidate clean enough for the approval queue.",
    setup: [`Trend: ${snapshot.trend}.`, `Bias: ${snapshot.bias}.`, `Score: ${snapshot.score}/100.`],
    riskNotes: ["Wait for cleaner conditions before creating an executable paper order."],
    warnings: input.analysisRun.safetyBlockers.map((blocker) => blocker.message)
  }];
}

function selectStrategies(strategies: StrategyCandidate[]): StrategyCandidate[] {
  const actionable = strategies.filter((strategy) => strategy.suitability === "candidate" || strategy.suitability === "research");
  const preferred = actionable.length ? actionable : strategies.filter((strategy) => strategy.suitability === "watch");
  const ranked = preferred
    .filter((strategy) => strategy.suitability !== "avoid")
    .sort((left, right) => right.score - left.score)
    .slice(0, PROPOSAL_LIMIT);
  const executableLong = strategies.find((strategy) => strategy.kind === "long_stock" && strategy.suitability === "candidate");
  const executableShort = strategies.find((strategy) => strategy.kind === "short_stock" && strategy.suitability === "research");
  const required = [executableLong, executableShort].filter((strategy): strategy is StrategyCandidate => Boolean(strategy));
  const merged = [...required, ...ranked.filter((strategy) => !required.some((item) => item.kind === strategy.kind))];
  return merged.slice(0, PROPOSAL_LIMIT);
}

function buildPaperOrder(strategy: StrategyCandidate, input: BuildAlgoProposalInput, horizon: ReturnType<typeof deriveTradeHorizon>): PaperOrderRequest | undefined {
  if (strategy.kind !== "long_stock" && strategy.kind !== "short_stock") return undefined;
  const snapshot = input.analysisRun.snapshot;
  if (!snapshot.lastPrice) return undefined;
  if (strategy.kind === "long_stock" && strategy.suitability !== "candidate") return undefined;
  if (strategy.kind === "short_stock" && strategy.suitability !== "research") return undefined;

  const equity = input.account.equity ?? 100000;
  const maxNotional = equity * input.riskSettings.maxPositionPct;
  const riskPlan = strategy.kind === "short_stock" ? getShortRiskPlan(input) : getLongRiskPlan(input);
  if (!riskPlan) return undefined;
  const suggestedShares = getSharesForRisk(snapshot.lastPrice, riskPlan.stopLossPrice, equity, input.riskSettings, strategy.kind === "short_stock" ? "sell" : "buy");
  const maxSharesByNotional = Math.max(1, Math.floor(maxNotional / snapshot.lastPrice));
  const quantity = Math.max(1, Math.min(Math.floor(suggestedShares ?? 1), maxSharesByNotional));

  return {
    symbol: snapshot.symbol,
    side: strategy.kind === "short_stock" ? "sell" : "buy",
    orderType: "market",
    quantity,
    stopLossPrice: riskPlan.stopLossPrice,
    takeProfitPrice: riskPlan.takeProfitPrice,
    timeInForce: selectDefaultTimeInForce({ horizon, assetClass: "stock", strategyKind: strategy.kind }),
    horizon,
    earningsChecked: false,
    confirmedPaperOnly: false,
    acceptedRisk: false
  };
}

function buildOptionOrder(strategy: StrategyCandidate, input: BuildAlgoProposalInput, horizon: ReturnType<typeof deriveTradeHorizon>): OptionOrderRequest | undefined {
  if (strategy.kind !== "long_call" && strategy.kind !== "long_put") return undefined;
  if (strategy.suitability !== "research" || !strategy.representativeContract) return undefined;
  const maxLoss = strategy.estimatedMaxLoss ?? null;
  const equity = input.account.equity ?? 100000;
  if (!maxLoss || maxLoss > equity * input.riskSettings.maxRiskPerTradePct) return undefined;
  const premium = round(maxLoss / 100, 2);
  return {
    contractSymbol: strategy.representativeContract,
    underlyingSymbol: input.analysisRun.symbol,
    optionType: strategy.kind === "long_call" ? "call" : "put",
    orderType: "limit",
    quantity: 1,
    limitPrice: premium,
    timeInForce: selectDefaultTimeInForce({ horizon, assetClass: "option", strategyKind: strategy.kind }),
    horizon,
    estimatedPremium: premium,
    estimatedMaxLoss: maxLoss,
    earningsChecked: false,
    confirmedPaperOnly: false,
    acceptedRisk: false
  };
}

function getExecutionType(
  strategy: StrategyCandidate,
  order: PaperOrderRequest | undefined,
  optionOrder: OptionOrderRequest | undefined
): AlgoTradeProposal["executionType"] {
  if (strategy.kind === "long_stock" && order) return "long_stock_bracket";
  if (strategy.kind === "short_stock" && order) return "short_stock_bracket";
  if ((strategy.kind === "long_call" || strategy.kind === "long_put") && optionOrder) return "long_option";
  return "research_only";
}

function getLongRiskPlan(input: BuildAlgoProposalInput): { stopLossPrice: number; takeProfitPrice: number } | null {
  const snapshot = input.analysisRun.snapshot;
  if (!snapshot.suggestedStop || !snapshot.suggestedTarget) return null;
  return {
    stopLossPrice: round(snapshot.suggestedStop, 2),
    takeProfitPrice: round(snapshot.suggestedTarget, 2)
  };
}

function getShortRiskPlan(input: BuildAlgoProposalInput): { stopLossPrice: number; takeProfitPrice: number } | null {
  const snapshot = input.analysisRun.snapshot;
  if (!snapshot.lastPrice || !snapshot.atr14) return null;
  const stopByAtr = snapshot.lastPrice + snapshot.atr14 * 1.5;
  const stopByRecentHigh = snapshot.recentHigh && snapshot.recentHigh > snapshot.lastPrice ? snapshot.recentHigh + snapshot.atr14 * 0.25 : stopByAtr;
  const targetByAtr = snapshot.lastPrice - snapshot.atr14 * 3;
  const targetByBreakdown = snapshot.recentLow && snapshot.recentLow < snapshot.lastPrice ? snapshot.recentLow - snapshot.atr14 : targetByAtr;
  const stopLossPrice = round(Math.max(stopByAtr, stopByRecentHigh), 2);
  const takeProfitPrice = round(Math.min(targetByAtr, targetByBreakdown), 2);
  if (stopLossPrice <= snapshot.lastPrice || takeProfitPrice >= snapshot.lastPrice) return null;
  const riskReward = (snapshot.lastPrice - takeProfitPrice) / (stopLossPrice - snapshot.lastPrice);
  return riskReward >= input.riskSettings.minRiskReward ? { stopLossPrice, takeProfitPrice } : null;
}

function getSharesForRisk(
  entryPrice: number,
  stopLossPrice: number,
  equity: number,
  riskSettings: RiskSettings,
  side: "buy" | "sell"
): number | null {
  const riskPerShare = side === "sell" ? stopLossPrice - entryPrice : entryPrice - stopLossPrice;
  if (riskPerShare <= 0) return null;
  return Math.floor((equity * riskSettings.maxRiskPerTradePct) / riskPerShare);
}

function buildWarnings(
  strategy: StrategyCandidate,
  validation: PaperOrderValidationResult | undefined,
  hardBlocked: boolean
): string[] {
  const warnings = [...strategy.warnings];
  if (hardBlocked) warnings.push("Hard safety blockers prevent executable order placement.");
  if (!["long_stock", "short_stock", "long_call", "long_put"].includes(strategy.kind)) {
    warnings.push("Research only: broker execution for this strategy is not enabled yet.");
  }
  if (strategy.kind === "short_stock") warnings.push("Short-selling requires margin/borrow availability and can lose more than the initial plan if price gaps.");
  if (strategy.kind === "long_call" || strategy.kind === "long_put") warnings.push("Options orders are single-leg paper limit orders only; spreads remain research-only.");
  if (validation && !validation.ok) warnings.push(...validation.errors);
  if (validation?.warnings.length) warnings.push(...validation.warnings);
  return [...new Set(warnings)].slice(0, 8);
}
