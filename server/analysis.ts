import type {
  AnalysisMode,
  AnalysisRun,
  BrokerAccountSnapshot,
  ManagerVerdict,
  OptionIdea,
  RiskSettings,
  SafetyBlocker,
  SignalBias,
  SignalSnapshot,
  SpecialistReport,
  TradeContext,
  TradeJournalEntry
} from "../src/shared/types";
import { round } from "./indicators";

interface BuildAnalysisInput {
  mode: AnalysisMode;
  snapshot: SignalSnapshot;
  context: TradeContext;
  options: OptionIdea[];
  account: BrokerAccountSnapshot | { equity?: number | null };
  positions: unknown[];
  journal: TradeJournalEntry[];
  riskSettings: RiskSettings;
  marketSnapshots: SignalSnapshot[];
  managerVerdict?: ManagerVerdict;
}

export function buildAnalysisRun(input: BuildAnalysisInput): AnalysisRun {
  const specialistReports = buildSpecialistReports(input);
  const safetyBlockers = buildSafetyBlockers(input);
  const managerVerdict = input.managerVerdict ?? buildFallbackManagerVerdict(input.snapshot, specialistReports, safetyBlockers);

  return {
    id: `analysis-${input.snapshot.symbol}-${Date.now()}`,
    symbol: input.snapshot.symbol,
    createdAt: new Date().toISOString(),
    mode: input.mode,
    signalAsOf: input.snapshot.asOf,
    snapshot: input.snapshot,
    context: input.context,
    specialistReports,
    safetyBlockers,
    managerVerdict
  };
}

export function buildSpecialistReports(input: BuildAnalysisInput): SpecialistReport[] {
  return [
    buildTechnicalReport(input.snapshot, input.marketSnapshots),
    buildMarketReport(input.marketSnapshots),
    buildFundamentalsReport(input.context, input.riskSettings),
    buildOptionsReport(input.options),
    buildRiskReport(input.snapshot, input.account, input.positions, input.riskSettings),
    buildJournalReport(input.snapshot.symbol, input.journal)
  ];
}

export function buildSafetyBlockers(input: BuildAnalysisInput): SafetyBlocker[] {
  const blockers: SafetyBlocker[] = [];
  const equity = getEquity(input.account);
  const maxRisk = equity * input.riskSettings.maxRiskPerTradePct;
  const maxPosition = equity * input.riskSettings.maxPositionPct;
  const signalAgeMinutes = (Date.now() - new Date(input.snapshot.asOf).getTime()) / 60000;

  if (input.riskSettings.killSwitchEnabled) {
    blockers.push({
      code: "kill_switch",
      severity: "blocker",
      message: "Paper order entry is disabled because the kill switch is enabled."
    });
  }

  if (!Number.isFinite(signalAgeMinutes) || signalAgeMinutes > input.riskSettings.maxDataAgeMinutes) {
    blockers.push({
      code: "stale_signal",
      severity: "blocker",
      message: `Signal data is older than ${input.riskSettings.maxDataAgeMinutes} minutes. Refresh before considering a trade.`
    });
  }

  if (!input.snapshot.suggestedStop || !input.snapshot.suggestedTarget || !input.snapshot.lastPrice) {
    blockers.push({
      code: "missing_risk_plan",
      severity: "blocker",
      message: "A stop, target, and current reference price are required before any paper order."
    });
  }

  if ((input.snapshot.riskReward ?? 0) > 0 && (input.snapshot.riskReward ?? 0) < input.riskSettings.minRiskReward) {
    blockers.push({
      code: "low_risk_reward",
      severity: "warning",
      message: `Risk/reward is below the configured ${input.riskSettings.minRiskReward}:1 minimum.`
    });
  }

  if ((input.snapshot.riskDollars ?? 0) > maxRisk) {
    blockers.push({
      code: "max_risk",
      severity: "blocker",
      message: `Estimated risk exceeds the configured max per-trade risk of ${round(maxRisk, 2)}.`
    });
  }

  if ((input.snapshot.positionNotional ?? 0) > maxPosition) {
    blockers.push({
      code: "max_position",
      severity: "blocker",
      message: `Estimated position exceeds the configured max notional of ${round(maxPosition, 2)}.`
    });
  }

  const nextEarnings = input.context.earnings?.nextEarningsDate ? new Date(input.context.earnings.nextEarningsDate) : null;
  if (nextEarnings && Number.isFinite(nextEarnings.getTime())) {
    const days = (nextEarnings.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (days >= 0 && days <= input.riskSettings.earningsWindowDays) {
      blockers.push({
        code: "earnings_window",
        severity: "warning",
        message: `Earnings are within ${input.riskSettings.earningsWindowDays} days; reduce risk or wait.`
      });
    }
  }

  if (input.positions.some((position) => getPositionSymbol(position) === input.snapshot.symbol)) {
    blockers.push({
      code: "duplicate_exposure",
      severity: "warning",
      message: "There is already an open paper position in this symbol."
    });
  }

  return blockers;
}

export function buildFallbackManagerVerdict(
  snapshot: SignalSnapshot,
  reports: SpecialistReport[],
  blockers: SafetyBlocker[]
): ManagerVerdict {
  const hardBlock = blockers.some((blocker) => blocker.severity === "blocker");
  const bullishVotes = reports.filter((report) => report.bias === "bullish").length;
  const bearishVotes = reports.filter((report) => report.bias === "bearish").length;
  const action = hardBlock
    ? "avoid"
    : snapshot.bias === "bullish" && snapshot.score >= 70 && bullishVotes > bearishVotes
      ? "paper_long_candidate"
      : bearishVotes > bullishVotes
        ? "avoid"
        : "watch";

  return {
    symbol: snapshot.symbol,
    action,
    bias: hardBlock ? "caution" : snapshot.bias,
    confidence: hardBlock || snapshot.score < 55 ? "low" : snapshot.score >= 75 ? "medium" : "low",
    summary: hardBlock
      ? "Hard safety rules block this setup until the issues are resolved."
      : "The deterministic reports are mixed enough that this should stay advisory and manually reviewed.",
    scenarios: [
      {
        label: "bullish",
        summary: "Setup improves if price holds trend support and volume confirms.",
        trigger: snapshot.suggestedTarget ? `Break or approach ${snapshot.suggestedTarget}.` : "Fresh bullish scan confirmation."
      },
      {
        label: "base",
        summary: "Best default is to wait for cleaner confirmation and preserve risk.",
        trigger: "Trend, risk/reward, and event checks all align."
      },
      {
        label: "bearish",
        summary: "Setup fails if price loses the risk level or market regime weakens.",
        trigger: snapshot.suggestedStop ? `Lose ${snapshot.suggestedStop}.` : "Trend flips down."
      }
    ],
    entryRequirements: [
      "Refresh price data before acting.",
      "Confirm no hard safety blockers remain.",
      "Use a stop, target, and small paper size."
    ],
    invalidation: snapshot.suggestedStop ? `A move below ${snapshot.suggestedStop} invalidates the long setup.` : "Missing stop invalidates the setup.",
    dissent: reports.flatMap((report) => report.warnings.slice(0, 1)).slice(0, 4),
    checklist: [
      "Check earnings and news timing.",
      "Confirm risk/reward and position size.",
      "Use paper-only manual approval."
    ],
    warnings: blockers.map((blocker) => blocker.message).slice(0, 6)
  };
}

function buildTechnicalReport(snapshot: SignalSnapshot, marketSnapshots: SignalSnapshot[]): SpecialistReport {
  const spy = marketSnapshots.find((market) => market.symbol === "SPY");
  const relativeStrength = spy ? getPercentChange(snapshot.bars, 20) - getPercentChange(spy.bars, 20) : null;
  const evidence = [
    `Trend: ${snapshot.trend}.`,
    `Score: ${snapshot.score}/100.`,
    snapshot.rsi14 !== null ? `RSI: ${snapshot.rsi14}.` : "RSI unavailable.",
    snapshot.atr14 !== null && snapshot.lastPrice ? `ATR: ${round((snapshot.atr14 / snapshot.lastPrice) * 100, 2)}% of price.` : "ATR unavailable.",
    relativeStrength !== null ? `20-bar relative strength vs SPY: ${round(relativeStrength, 2)} percentage points.` : "Relative strength unavailable."
  ];

  return {
    kind: "technical",
    title: "Technical setup",
    score: snapshot.score,
    bias: snapshot.bias,
    summary: snapshot.notes[0] ?? `Current technical bias is ${snapshot.bias}.`,
    evidence,
    warnings: snapshot.notes.filter((note) => /weak|extended|below|not enough|mixed/i.test(note))
  };
}

function buildMarketReport(marketSnapshots: SignalSnapshot[]): SpecialistReport {
  const evidence = marketSnapshots.map((snapshot) => `${snapshot.symbol}: ${snapshot.trend}, ${snapshot.bias}, score ${snapshot.score}.`);
  const bullish = marketSnapshots.filter((snapshot) => snapshot.bias === "bullish").length;
  const bearish = marketSnapshots.filter((snapshot) => snapshot.bias === "bearish" || snapshot.trend === "downtrend").length;
  const bias: SignalBias = bearish > bullish ? "bearish" : bullish > 0 ? "bullish" : "neutral";

  return {
    kind: "market",
    title: "Market regime",
    score: marketSnapshots.length ? Math.round(marketSnapshots.reduce((sum, snapshot) => sum + snapshot.score, 0) / marketSnapshots.length) : 50,
    bias,
    summary: marketSnapshots.length ? "Broad-market ETFs are included as regime checks." : "Market regime data was unavailable.",
    evidence: evidence.length ? evidence : ["No SPY/QQQ regime snapshots were available."],
    warnings: bearish > 0 ? ["Broad-market trend is weak or bearish."] : []
  };
}

function buildFundamentalsReport(context: TradeContext, riskSettings: RiskSettings): SpecialistReport {
  const warnings = [...context.contextWarnings];
  const evidence = [
    context.fundamentals?.sector ? `Sector: ${context.fundamentals.sector}.` : "Sector unavailable.",
    context.earnings?.nextEarningsDate ? `Next earnings: ${context.earnings.nextEarningsDate}.` : "Next earnings unavailable.",
    `News items: ${context.news.length}.`,
    `Recent filings: ${context.recentFilings.length}.`
  ];
  const nextEarnings = context.earnings?.nextEarningsDate ? new Date(context.earnings.nextEarningsDate) : null;
  if (nextEarnings && Number.isFinite(nextEarnings.getTime())) {
    const days = (nextEarnings.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (days >= 0 && days <= riskSettings.earningsWindowDays) {
      warnings.push("Upcoming earnings are close enough to affect swing-trade risk.");
    }
  }

  return {
    kind: "fundamentals",
    title: "Fundamentals and events",
    score: warnings.length ? 45 : 60,
    bias: warnings.length ? "caution" : "neutral",
    summary: warnings.length ? "Event or provider warnings need review." : "No major event warning was detected from available context.",
    evidence,
    warnings
  };
}

function buildOptionsReport(options: OptionIdea[]): SpecialistReport {
  const liquid = options.filter((option) => !option.liquidityWarning && (option.openInterest ?? 0) >= 100);
  const lowLoss = liquid.filter((option) => (option.maxLoss ?? Number.POSITIVE_INFINITY) <= 500);
  const warnings = options.length && !liquid.length ? ["Loaded contracts have weak or missing liquidity."] : [];

  return {
    kind: "options",
    title: "Options research",
    score: options.length ? Math.min(85, 35 + liquid.length * 5 + lowLoss.length * 3) : 30,
    bias: liquid.length ? "neutral" : "caution",
    summary: options.length ? `${options.length} contracts loaded; ${liquid.length} pass basic liquidity checks.` : "No options contracts were available.",
    evidence: [
      `Contracts loaded: ${options.length}.`,
      `Liquid candidates: ${liquid.length}.`,
      lowLoss.length ? `Lower max-loss contracts under $500: ${lowLoss.length}.` : "No low max-loss contract stood out."
    ],
    warnings
  };
}

function buildRiskReport(
  snapshot: SignalSnapshot,
  account: BrokerAccountSnapshot | { equity?: number | null },
  positions: unknown[],
  riskSettings: RiskSettings
): SpecialistReport {
  const equity = getEquity(account);
  const evidence = [
    `Equity reference: ${round(equity, 2)}.`,
    `Max risk per trade: ${round(equity * riskSettings.maxRiskPerTradePct, 2)}.`,
    `Suggested risk: ${snapshot.riskDollars ?? "unavailable"}.`,
    `Open positions: ${positions.length}.`
  ];
  const warnings: string[] = [];
  if ((snapshot.riskReward ?? 0) > 0 && (snapshot.riskReward ?? 0) < riskSettings.minRiskReward) warnings.push("Risk/reward is below configured minimum.");
  if (positions.some((position) => getPositionSymbol(position) === snapshot.symbol)) warnings.push("Existing position already uses this symbol.");
  if (riskSettings.killSwitchEnabled) warnings.push("Kill switch is enabled.");

  return {
    kind: "risk",
    title: "Risk controls",
    score: warnings.length ? 35 : 70,
    bias: warnings.length ? "caution" : "neutral",
    summary: warnings.length ? "Risk controls found issues that need review." : "No hard risk issue was detected by deterministic checks.",
    evidence,
    warnings
  };
}

function buildJournalReport(symbol: string, journal: TradeJournalEntry[]): SpecialistReport {
  const matching = journal.filter((entry) => entry.symbol === symbol);
  const closed = matching.filter((entry) => entry.status === "paper_closed");
  const wins = closed.filter((entry) => entry.outcome === "win").length;
  const losses = closed.filter((entry) => entry.outcome === "loss").length;

  return {
    kind: "journal",
    title: "Journal memory",
    score: closed.length ? Math.max(20, Math.min(80, 50 + (wins - losses) * 10)) : 50,
    bias: wins > losses ? "bullish" : losses > wins ? "caution" : "neutral",
    summary: closed.length ? `${closed.length} closed paper journal entries found for this symbol.` : "No closed paper-trade history for this symbol yet.",
    evidence: [`Matching entries: ${matching.length}.`, `Closed entries: ${closed.length}.`, `Wins/losses: ${wins}/${losses}.`],
    warnings: losses > wins ? ["Prior closed paper trades in this symbol lean negative."] : []
  };
}

function getEquity(account: BrokerAccountSnapshot | { equity?: number | null }): number {
  return typeof account.equity === "number" && Number.isFinite(account.equity) ? account.equity : 100000;
}

function getPositionSymbol(position: unknown): string | null {
  if (!position || typeof position !== "object") return null;
  const value = (position as { symbol?: unknown }).symbol;
  return typeof value === "string" ? value.toUpperCase() : null;
}

function getPercentChange(bars: SignalSnapshot["bars"], lookback: number): number {
  const recent = bars.slice(-lookback - 1);
  const first = recent.at(0)?.close;
  const last = recent.at(-1)?.close;
  if (!first || !last) return 0;
  return ((last - first) / first) * 100;
}
