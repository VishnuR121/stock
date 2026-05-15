import type {
  AlgoTradeProposal,
  AnalysisRun,
  BrokerAccountSnapshot,
  MultiLegPaperOrderValidationResult,
  PaperOrderRequest,
  PaperOrderValidationResult,
  RiskSettings,
  StrategyCandidate,
  StrategyKind,
  TradeExpression,
  TradeExpressionType
} from "../src/shared/types";
import {
  checkDayOrderTargetRealism,
  deriveTradeHorizon,
  expectedHoldingPeriod,
  selectDefaultTimeInForce
} from "../src/shared/orderHorizon";
import { round } from "./indicators";
import { validateMultiLegPaperOrder, validatePaperOrder } from "./validation";

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
    const expression = findTradeExpression(input.analysisRun, strategy.kind);
    const multiLegOrder = expression?.multiLegOrder;
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
      : multiLegOrder
        ? validateMultiLegPaperOrder(
            {
              ...multiLegOrder,
              timeHorizon: expression.timeHorizon,
              earningsChecked: true,
              confirmedPaperOnly: true,
              acceptedRisk: true,
              maxLossAcknowledged: true,
              paperSimulationAcknowledged: true,
              noLiveEndpointAcknowledged: true,
              sourceAnalysisId: input.analysisRun.id,
              sourceExpressionId: expression.id,
              followedPlan: true
            },
            {
              accountEquity: input.account.equity ?? 100000,
              maxRiskPerTradePct: input.riskSettings.maxRiskPerTradePct,
              maxPositionPct: input.riskSettings.maxPositionPct,
              maxDailyLossPct: input.riskSettings.maxDailyLossPct,
              minRiskReward: input.riskSettings.minRiskReward
            },
            input.riskSettings,
            {
              buyingPower: getBuyingPower(input.account),
              alpacaPaperOnly: true,
              now: input.now
            }
          )
      : undefined;
    const targetRealism = order
      ? checkDayOrderTargetRealism({ order, referencePrice, now: input.now })
      : undefined;
    const executable = Boolean(
      !hardBlocked &&
      validation?.ok &&
      (order || multiLegOrder) &&
      (strategy.kind === "long_stock" || strategy.kind === "short_stock" || Boolean(multiLegOrder))
    );
    const workflowStatus = getWorkflowStatus({ hardBlocked, strategy, order, expression, validation, executable });
    const blockedReasons = getBlockedReasons(strategy, expression, validation, hardBlocked);

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
      workflowStatus,
      executionType: getExecutionType(strategy, order, multiLegOrder),
      horizon,
      expectedHoldingPeriod: holdingPeriod,
      executable,
      score: strategy.score,
      summary: strategy.summary,
      setup: strategy.setup,
      riskNotes: strategy.riskNotes,
      warnings: buildWarnings(strategy, expression, validation, hardBlocked),
      blockedReasons,
      howToFix: getHowToFix(workflowStatus, blockedReasons, expression),
      expressionType: expression?.expressionType,
      requiredCapital: expression?.requiredCapital,
      maxLoss: expression?.maxLoss,
      maxProfit: expression?.maxProfit,
      breakeven: expression?.breakeven,
      dte: expression?.dte,
      liquidityScore: expression?.liquidityScore,
      paperExecutionMode: expression?.paperExecutionMode,
      selectedContracts: multiLegOrder?.legs,
      order,
      multiLegOrder,
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
    workflowStatus: "blocked",
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
  const optionFocus = strategies
    .filter((strategy) => isOptionsStrategy(strategy.kind))
    .sort((left, right) => right.score - left.score)[0];
  const required = [executableLong, executableShort].filter((strategy): strategy is StrategyCandidate => Boolean(strategy));
  const merged = [
    ...required,
    ...(optionFocus && !required.some((item) => item.kind === optionFocus.kind) ? [optionFocus] : []),
    ...ranked.filter((strategy) => !required.some((item) => item.kind === strategy.kind) && strategy.kind !== optionFocus?.kind)
  ];
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

function getExecutionType(
  strategy: StrategyCandidate,
  order: PaperOrderRequest | undefined,
  multiLegOrder?: unknown
): AlgoTradeProposal["executionType"] {
  if (strategy.kind === "long_stock" && order) return "long_stock_bracket";
  if (strategy.kind === "short_stock" && order) return "short_stock_bracket";
  if (multiLegOrder) return "internal_options_simulation";
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
  expression: TradeExpression | undefined,
  validation: PaperOrderValidationResult | MultiLegPaperOrderValidationResult | undefined,
  hardBlocked: boolean
): string[] {
  const warnings = [...strategy.warnings];
  if (hardBlocked) warnings.push("Hard safety blockers prevent executable order placement.");
  if (!["long_stock", "short_stock"].includes(strategy.kind) && !expression?.multiLegOrder) warnings.push("Needs exact contract selection before paper simulation.");
  if (strategy.kind === "short_stock") warnings.push("Short-selling requires margin/borrow availability and can lose more than the initial plan if price gaps.");
  if (expression?.paperExecutionMode === "internal_simulation") warnings.push("Options are internally simulated paper trades, not broker options submissions.");
  if (expression?.statusReasons.length) warnings.push(...expression.statusReasons);
  if (expression?.optionSelectionDiagnostics?.rejectionReasons.length) warnings.push(...expression.optionSelectionDiagnostics.rejectionReasons);
  if (validation && !validation.ok) warnings.push(...validation.errors);
  if (validation?.warnings.length) warnings.push(...validation.warnings);
  return [...new Set(warnings)].slice(0, 8);
}

function findTradeExpression(analysisRun: AnalysisRun, strategyKind: StrategyKind): TradeExpression | undefined {
  const expressionType = getExpressionTypeForStrategy(strategyKind);
  if (!expressionType || !analysisRun.tradeExpressionResult) return undefined;
  const expressions = [
    analysisRun.tradeExpressionResult.recommendedExpression,
    ...analysisRun.tradeExpressionResult.alternatives,
    ...analysisRun.tradeExpressionResult.blockedExpressions
  ];
  return expressions.find((expression) => expression.expressionType === expressionType);
}

function getExpressionTypeForStrategy(strategyKind: StrategyKind): TradeExpressionType | null {
  const map: Partial<Record<StrategyKind, TradeExpressionType>> = {
    long_stock: "long_equity",
    short_stock: "short_equity",
    long_call: "long_call",
    long_put: "long_put",
    call_debit_spread: "bull_call_debit_spread",
    put_debit_spread: "bear_put_debit_spread",
    covered_call: "covered_call",
    cash_secured_put: "cash_secured_put",
    watch_only: "no_trade"
  };
  return map[strategyKind] ?? null;
}

function getWorkflowStatus(input: {
  hardBlocked: boolean;
  strategy: StrategyCandidate;
  order?: PaperOrderRequest;
  expression?: TradeExpression;
  validation?: PaperOrderValidationResult | MultiLegPaperOrderValidationResult;
  executable: boolean;
}): NonNullable<AlgoTradeProposal["workflowStatus"]> {
  if (input.hardBlocked || input.validation?.ok === false) return "blocked";
  if (input.executable) return "paper_eligible";
  if (input.order && input.strategy.kind !== "watch_only") return "idea_only";
  if (isOptionsStrategy(input.strategy.kind)) {
    if (!input.expression || !input.expression.multiLegOrder) return "needs_contract_selection";
    if (input.expression.status === "blocked") return "blocked";
    if (input.expression.status === "research_only") return "research_only";
    return "needs_contract_selection";
  }
  if (input.expression?.status === "blocked") return "blocked";
  return input.strategy.suitability === "avoid" ? "blocked" : "idea_only";
}

function getBlockedReasons(
  strategy: StrategyCandidate,
  expression: TradeExpression | undefined,
  validation: PaperOrderValidationResult | MultiLegPaperOrderValidationResult | undefined,
  hardBlocked: boolean
): string[] {
  const reasons: string[] = [];
  if (hardBlocked) reasons.push("Hard safety blockers prevent executable order placement.");
  if (expression?.statusReasons.length) reasons.push(...expression.statusReasons);
  if (validation && !validation.ok) reasons.push(...validation.errors);
  if (isOptionsStrategy(strategy.kind) && !expression?.multiLegOrder) reasons.push("No exact option contract or leg set is selected.");
  return [...new Set(reasons)];
}

function getHowToFix(
  workflowStatus: NonNullable<AlgoTradeProposal["workflowStatus"]>,
  blockedReasons: string[],
  expression: TradeExpression | undefined
): string[] {
  if (workflowStatus === "paper_eligible") return ["Review warnings, confirm paper-only execution, then approve from the Algo card."];
  if (workflowStatus === "needs_contract_selection") {
    const diagnostics = expression?.optionSelectionDiagnostics;
    return diagnostics?.rejectionReasons.length
      ? diagnostics.rejectionReasons
      : ["Select exact option contracts/legs and rerun deterministic validation."];
  }
  if (workflowStatus === "blocked") return blockedReasons.length ? blockedReasons : ["Resolve risk, data, liquidity, or safety blockers."];
  if (workflowStatus === "research_only") return ["This strategy remains research-only until safe paper simulation support is enabled."];
  return ["Review the idea and build a validated paper order before execution."];
}

function isOptionsStrategy(strategyKind: StrategyKind): boolean {
  return ["long_call", "long_put", "call_debit_spread", "put_debit_spread", "covered_call", "cash_secured_put"].includes(strategyKind);
}

function getBuyingPower(account: BrokerAccountSnapshot | { equity?: number | null }): number {
  const candidate = "buyingPower" in account ? account.buyingPower : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : account.equity ?? 100000;
}
