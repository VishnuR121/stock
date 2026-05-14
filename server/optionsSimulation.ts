import type {
  ExitUrgency,
  OptionIdea,
  OptionLeg,
  OptionsExposureBucket,
  SimulatedOptionQuoteStatus,
  SimulatedOptionsPosition,
  SimulatedOptionsSnapshot,
  TradeJournalEntry
} from "../src/shared/types";

const CONTRACT_MULTIPLIER = 100;
const WATCH_DTE = 14;
const EXIT_DTE = 3;
const PROFIT_WATCH_FRACTION = 0.5;
const PROFIT_EXIT_FRACTION = 0.75;
const LOSS_WATCH_FRACTION = 0.5;
const LOSS_EXIT_FRACTION = 0.75;

export function buildSimulatedOptionsSnapshot(input: {
  journal: TradeJournalEntry[];
  optionsByUnderlying?: Record<string, OptionIdea[]>;
  now?: Date;
}): SimulatedOptionsSnapshot {
  const now = input.now ?? new Date();
  const quoteMap = buildQuoteMap(input.optionsByUnderlying ?? {});
  const positions = input.journal
    .filter(isOpenSimulatedOptionsEntry)
    .map((entry) => buildPosition(entry, quoteMap, now));

  return {
    generatedAt: now.toISOString(),
    positions,
    exposure: buildExposure(positions)
  };
}

function buildPosition(
  entry: TradeJournalEntry,
  quoteMap: Map<string, OptionIdea>,
  now: Date
): SimulatedOptionsPosition {
  const legs = entry.optionLegs ?? [];
  const legValues = legs.map((leg) => getLegValues(leg, quoteMap.get(leg.optionSymbol)));
  const currentValue = round(legValues.reduce((sum, leg) => sum + leg.currentSignedValue, 0));
  const entryValue = round(getJournalEntryValue(entry, legValues));
  const unrealizedPnL = round(currentValue - entryValue);
  const unrealizedPnLPct = Math.abs(entryValue) > 0 ? round(unrealizedPnL / Math.abs(entryValue), 4) : null;
  const daysToExpiration = getMinDte(legs, now);
  const quoteStatus = getQuoteStatus(legValues);
  const warnings = buildWarnings(entry, legValues, quoteStatus);
  const exit = buildExitGuidance({
    entry,
    legs,
    daysToExpiration,
    unrealizedPnL,
    unrealizedPnLPct,
    quoteStatus,
    warnings
  });

  return {
    id: getSimulationId(entry),
    journalEntryId: entry.id,
    symbol: entry.symbol,
    underlyingSymbol: entry.underlyingSymbol ?? entry.symbol,
    expressionType: entry.expressionType,
    openedAt: entry.createdAt,
    status: entry.status,
    legs,
    entryValue,
    currentValue,
    maxLoss: entry.maxLoss,
    maxProfit: entry.maxProfit,
    breakeven: entry.breakeven,
    requiredCapital: entry.requiredCapital,
    daysToExpiration,
    unrealizedPnL,
    unrealizedPnLPct,
    realizedPnL: entry.realizedPnL,
    actualRMultiple: entry.actualRMultiple,
    paperExecutionMode: entry.paperExecutionMode,
    quoteStatus,
    exitUrgency: exit.urgency,
    suggestedAction: exit.suggestedAction,
    exitReasons: exit.reasons,
    warnings
  };
}

function isOpenSimulatedOptionsEntry(entry: TradeJournalEntry): boolean {
  return entry.status === "paper_open"
    && entry.paperExecutionMode === "internal_simulation"
    && Array.isArray(entry.optionLegs)
    && entry.optionLegs.length > 0;
}

function getLegValues(leg: OptionLeg, quote?: OptionIdea) {
  const entryPrice = getLegEntryPrice(leg);
  const quotePrice = quote ? getOptionQuotePrice(quote) : null;
  const currentPrice = quotePrice ?? entryPrice;
  const quantity = Math.max(0, leg.quantity || 0);
  const direction = leg.side === "sell" ? -1 : 1;
  const entrySignedValue = round(direction * entryPrice * quantity * CONTRACT_MULTIPLIER);
  const currentSignedValue = round(direction * currentPrice * quantity * CONTRACT_MULTIPLIER);

  return {
    leg,
    entryPrice,
    currentPrice,
    entrySignedValue,
    currentSignedValue,
    hasQuote: quotePrice !== null,
    hasEntryPrice: entryPrice > 0
  };
}

function getJournalEntryValue(
  entry: TradeJournalEntry,
  legValues: Array<ReturnType<typeof getLegValues>>
): number {
  const estimatedDebit = numericMetadata(entry.optionsMetadata, "estimatedDebit");
  if (estimatedDebit !== undefined) return estimatedDebit;
  const estimatedCredit = numericMetadata(entry.optionsMetadata, "estimatedCredit");
  if (estimatedCredit !== undefined) return -estimatedCredit;
  return legValues.reduce((sum, leg) => sum + leg.entrySignedValue, 0);
}

function getLegEntryPrice(leg: OptionLeg): number {
  const price = leg.estimatedMid ?? leg.limitPrice ?? leg.last ?? midpoint(leg.bid, leg.ask);
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : 0;
}

function getOptionQuotePrice(quote: OptionIdea): number | null {
  const price = quote.midPrice ?? quote.lastPrice ?? quote.closePrice ?? midpoint(quote.bidPrice, quote.askPrice);
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

function midpoint(bid?: number | null, ask?: number | null): number | undefined {
  return typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0 ? (bid + ask) / 2 : undefined;
}

function getMinDte(legs: OptionLeg[], now: Date): number | null {
  const values = legs
    .map((leg) => getDaysToExpiration(leg.expiration, now))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function getDaysToExpiration(expirationDate: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) return null;
  const expiration = new Date(`${expirationDate}T21:00:00.000Z`);
  if (!Number.isFinite(expiration.getTime())) return null;
  return Math.ceil((expiration.getTime() - now.getTime()) / 86400000);
}

function getQuoteStatus(legValues: Array<ReturnType<typeof getLegValues>>): SimulatedOptionQuoteStatus {
  if (!legValues.length) return "missing_pricing";
  if (legValues.every((leg) => leg.hasQuote)) return "live_quote";
  if (legValues.every((leg) => leg.hasQuote || leg.hasEntryPrice)) return "entry_estimate";
  return "missing_pricing";
}

function buildWarnings(
  entry: TradeJournalEntry,
  legValues: Array<ReturnType<typeof getLegValues>>,
  quoteStatus: SimulatedOptionQuoteStatus
): string[] {
  const warnings = new Set(entry.strategyWarnings ?? []);
  if (quoteStatus === "entry_estimate") warnings.add("At least one current option quote is unavailable; valuation is using entry estimates.");
  if (quoteStatus === "missing_pricing") warnings.add("Option pricing is missing; P/L may be incomplete.");
  for (const value of legValues) {
    if (!value.hasEntryPrice) warnings.add(`${value.leg.optionSymbol} is missing entry price data.`);
    if (!value.hasQuote) warnings.add(`${value.leg.optionSymbol} is missing a current quote.`);
  }
  return [...warnings];
}

function buildExitGuidance(input: {
  entry: TradeJournalEntry;
  legs: OptionLeg[];
  daysToExpiration: number | null;
  unrealizedPnL: number;
  unrealizedPnLPct: number | null;
  quoteStatus: SimulatedOptionQuoteStatus;
  warnings: string[];
}): { urgency: ExitUrgency; suggestedAction: string; reasons: string[] } {
  const reasons: string[] = [];
  let urgency: ExitUrgency = "hold";

  if (input.daysToExpiration !== null && input.daysToExpiration <= 0) {
    urgency = "exit";
    reasons.push("Expiration has reached or passed; close or mark the simulation resolved.");
  } else if (input.daysToExpiration !== null && input.daysToExpiration <= EXIT_DTE) {
    urgency = "exit";
    reasons.push(`Only ${input.daysToExpiration} DTE remains, inside the ${EXIT_DTE}-day close rule.`);
  } else if (input.daysToExpiration !== null && input.daysToExpiration <= WATCH_DTE) {
    urgency = maxUrgency(urgency, "watch");
    reasons.push(`${input.daysToExpiration} DTE remains; prepare an exit or roll decision.`);
  }

  const maxProfit = input.entry.maxProfit;
  if (typeof maxProfit === "number" && maxProfit > 0) {
    if (input.unrealizedPnL >= maxProfit * PROFIT_EXIT_FRACTION) {
      urgency = "exit";
      reasons.push(`Open profit is at least ${Math.round(PROFIT_EXIT_FRACTION * 100)}% of max profit.`);
    } else if (input.unrealizedPnL >= maxProfit * PROFIT_WATCH_FRACTION) {
      urgency = maxUrgency(urgency, "watch");
      reasons.push(`Open profit is at least ${Math.round(PROFIT_WATCH_FRACTION * 100)}% of max profit.`);
    }
  }

  const maxLoss = input.entry.maxLoss;
  if (typeof maxLoss === "number" && maxLoss > 0) {
    if (input.unrealizedPnL <= -maxLoss * LOSS_EXIT_FRACTION) {
      urgency = "exit";
      reasons.push(`Open loss is at least ${Math.round(LOSS_EXIT_FRACTION * 100)}% of max loss.`);
    } else if (input.unrealizedPnL <= -maxLoss * LOSS_WATCH_FRACTION) {
      urgency = maxUrgency(urgency, "watch");
      reasons.push(`Open loss is at least ${Math.round(LOSS_WATCH_FRACTION * 100)}% of max loss.`);
    }
  }

  if (input.legs.some((leg) => leg.side === "sell") && input.daysToExpiration !== null && input.daysToExpiration <= WATCH_DTE) {
    urgency = maxUrgency(urgency, input.daysToExpiration <= EXIT_DTE ? "exit" : "watch");
    reasons.push("Short option leg has assignment risk as expiration approaches.");
  }

  if (input.quoteStatus !== "live_quote") {
    urgency = maxUrgency(urgency, "watch");
    reasons.push("Current quotes are incomplete, so exit decisions need manual price review.");
  }

  if (!reasons.length) reasons.push("No simulated options exit rule has triggered yet.");

  return {
    urgency,
    suggestedAction: urgency === "exit"
      ? "Review and close the paper simulation if the rule matches your plan."
      : urgency === "watch"
        ? "Watch closely and verify current option quotes before making an exit decision."
        : "Hold the simulation and keep monitoring P/L, DTE, and liquidity.",
    reasons
  };
}

function maxUrgency(left: ExitUrgency, right: ExitUrgency): ExitUrgency {
  const rank: Record<ExitUrgency, number> = { hold: 0, watch: 1, exit: 2 };
  return rank[right] > rank[left] ? right : left;
}

function buildExposure(positions: SimulatedOptionsPosition[]): SimulatedOptionsSnapshot["exposure"] {
  return {
    totalOpenSimulations: positions.length,
    totalMaxLoss: round(positions.reduce((sum, position) => sum + (position.maxLoss ?? 0), 0)),
    totalRequiredCapital: round(positions.reduce((sum, position) => sum + (position.requiredCapital ?? 0), 0)),
    totalUnrealizedPnL: round(positions.reduce((sum, position) => sum + position.unrealizedPnL, 0)),
    byUnderlying: bucketExposure(positions, (position) => position.underlyingSymbol),
    byExpressionType: bucketExposure(positions, (position) => position.expressionType ?? "unknown"),
    byDteBucket: bucketExposure(positions, (position) => getDteBucket(position.daysToExpiration))
  };
}

function bucketExposure(
  positions: SimulatedOptionsPosition[],
  getKey: (position: SimulatedOptionsPosition) => string
): OptionsExposureBucket[] {
  const buckets = new Map<string, OptionsExposureBucket>();
  for (const position of positions) {
    const key = getKey(position);
    const bucket = buckets.get(key) ?? {
      key,
      count: 0,
      maxLoss: 0,
      requiredCapital: 0,
      unrealizedPnL: 0
    };
    bucket.count += 1;
    bucket.maxLoss = round(bucket.maxLoss + (position.maxLoss ?? 0));
    bucket.requiredCapital = round(bucket.requiredCapital + (position.requiredCapital ?? 0));
    bucket.unrealizedPnL = round(bucket.unrealizedPnL + position.unrealizedPnL);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => right.maxLoss - left.maxLoss);
}

function getDteBucket(daysToExpiration: number | null): string {
  if (daysToExpiration === null) return "unknown";
  if (daysToExpiration <= 7) return "0-7 DTE";
  if (daysToExpiration <= 21) return "8-21 DTE";
  if (daysToExpiration <= 60) return "22-60 DTE";
  return "60+ DTE";
}

function buildQuoteMap(optionsByUnderlying: Record<string, OptionIdea[]>): Map<string, OptionIdea> {
  const map = new Map<string, OptionIdea>();
  for (const ideas of Object.values(optionsByUnderlying)) {
    for (const idea of ideas) {
      map.set(idea.symbol, idea);
    }
  }
  return map;
}

function getSimulationId(entry: TradeJournalEntry): string {
  const id = entry.optionsMetadata?.simulatedOrderId;
  return typeof id === "string" && id.trim() ? id : entry.id;
}

function numericMetadata(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number, places = 2): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}
