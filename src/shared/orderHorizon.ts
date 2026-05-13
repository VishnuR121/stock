import type {
  OrderLevelDistances,
  OrderTimeInForce,
  PaperOrderRequest,
  SignalSnapshot,
  StrategyKind,
  TargetRealismResult,
  TradeHorizon
} from "./types";

export const TRADE_HORIZONS = ["intraday", "swing", "position", "options_short_term"] as const;

const REGULAR_SESSION_OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_SESSION_CLOSE_MINUTES = 16 * 60;
const REGULAR_SESSION_LENGTH_MINUTES = REGULAR_SESSION_CLOSE_MINUTES - REGULAR_SESSION_OPEN_MINUTES;
const MAX_FULL_DAY_TARGET_PCT = 3;
const MIN_LATE_SESSION_TARGET_PCT = 0.5;

export function deriveTradeHorizon(input: {
  strategyKind?: StrategyKind;
  signal?: Pick<SignalSnapshot, "bars" | "atr14" | "sma20" | "sma50" | "sma200"> | null;
  timeframe?: string | null;
  usesDailyBars?: boolean;
} = {}): TradeHorizon {
  if (input.strategyKind === "long_call" || input.strategyKind === "long_put" || input.strategyKind === "call_debit_spread" || input.strategyKind === "put_debit_spread") {
    return "options_short_term";
  }

  if (input.strategyKind === "covered_call" || input.strategyKind === "cash_secured_put") {
    return "position";
  }

  if (input.usesDailyBars || isDailyTimeframe(input.timeframe) || signalUsesDailyBars(input.signal)) {
    return "swing";
  }

  return "intraday";
}

export function selectDefaultTimeInForce(input: {
  horizon: TradeHorizon;
  assetClass?: "stock" | "option";
  strategyKind?: StrategyKind;
}): OrderTimeInForce {
  if (
    input.assetClass === "option" ||
    input.horizon === "options_short_term" ||
    input.strategyKind === "long_call" ||
    input.strategyKind === "long_put"
  ) {
    return "day";
  }

  return input.horizon === "intraday" ? "day" : "gtc";
}

export function expectedHoldingPeriod(horizon: TradeHorizon): string {
  switch (horizon) {
    case "intraday":
      return "Same trading session";
    case "swing":
      return "Several days to a few weeks";
    case "position":
      return "Several weeks or longer";
    case "options_short_term":
      return "Short-term option entry; exits managed by Position Monitor";
  }
}

export function calculateOrderLevelDistances(
  order: Pick<PaperOrderRequest, "side" | "stopLossPrice" | "takeProfitPrice">,
  referencePrice?: number | null
): OrderLevelDistances | undefined {
  if (!referencePrice || referencePrice <= 0 || !Number.isFinite(referencePrice)) return undefined;
  if (!order.stopLossPrice || !order.takeProfitPrice) return undefined;

  const targetMovePct = ((order.takeProfitPrice - referencePrice) / referencePrice) * 100;
  const stopMovePct = ((order.stopLossPrice - referencePrice) / referencePrice) * 100;

  return {
    referencePrice,
    targetDistancePct: roundPct(Math.abs(targetMovePct)),
    stopDistancePct: roundPct(Math.abs(stopMovePct)),
    targetMovePct: roundPct(targetMovePct),
    stopMovePct: roundPct(stopMovePct)
  };
}

export function checkDayOrderTargetRealism(input: {
  order: Pick<PaperOrderRequest, "side" | "stopLossPrice" | "takeProfitPrice" | "timeInForce" | "horizon">;
  referencePrice?: number | null;
  horizon?: TradeHorizon;
  now?: Date;
}): TargetRealismResult {
  const horizon = input.horizon ?? input.order.horizon;
  const distances = calculateOrderLevelDistances(input.order, input.referencePrice);
  const minutesUntilSessionClose = input.order.timeInForce === "day"
    ? getTradingSessionMinutesRemaining(input.now ?? new Date())
    : null;
  const maxRealisticTargetPct = minutesUntilSessionClose === null
    ? null
    : getMaxRealisticDayTargetPct(minutesUntilSessionClose);
  const base = {
    ok: true,
    severity: "info",
    horizon,
    expectedHoldingPeriod: expectedHoldingPeriod(horizon),
    timeInForce: input.order.timeInForce,
    minutesUntilSessionClose,
    targetDistancePct: distances?.targetDistancePct ?? null,
    stopDistancePct: distances?.stopDistancePct ?? null,
    targetMovePct: distances?.targetMovePct ?? null,
    stopMovePct: distances?.stopMovePct ?? null,
    maxRealisticTargetPct
  } satisfies TargetRealismResult;

  if (!distances || input.order.timeInForce !== "day" || maxRealisticTargetPct === null) {
    return base;
  }

  if (distances.targetDistancePct > maxRealisticTargetPct) {
    const minutesText = `${minutesUntilSessionClose} ${minutesUntilSessionClose === 1 ? "minute" : "minutes"}`;
    return {
      ...base,
      ok: false,
      severity: "blocker",
      message: `Target is ${formatSignedPct(distances.targetMovePct)} away with ${minutesText} left. This is not realistic for a DAY order. Use GTC or revise the target.`
    };
  }

  if (horizon === "swing" || horizon === "position") {
    return {
      ...base,
      severity: "warning",
      message: `${formatHorizon(horizon)} horizon is using a DAY order. Confirm the target is intentionally same-session or use GTC.`
    };
  }

  return base;
}

export function getTradingSessionMinutesRemaining(now = new Date()): number {
  const parts = getEasternTimeParts(now);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return 0;

  const minutes = parts.hour * 60 + parts.minute;
  if (minutes < REGULAR_SESSION_OPEN_MINUTES) return REGULAR_SESSION_LENGTH_MINUTES;
  if (minutes >= REGULAR_SESSION_CLOSE_MINUTES) return 0;
  return REGULAR_SESSION_CLOSE_MINUTES - minutes;
}

export function formatHorizon(horizon: TradeHorizon): string {
  switch (horizon) {
    case "intraday":
      return "Intraday";
    case "swing":
      return "Swing";
    case "position":
      return "Position";
    case "options_short_term":
      return "Options short-term";
  }
}

function getMaxRealisticDayTargetPct(minutesUntilSessionClose: number): number {
  if (minutesUntilSessionClose <= 0) return 0;
  return roundPct(Math.max(MIN_LATE_SESSION_TARGET_PCT, MAX_FULL_DAY_TARGET_PCT * (minutesUntilSessionClose / REGULAR_SESSION_LENGTH_MINUTES)));
}

function signalUsesDailyBars(signal?: Pick<SignalSnapshot, "bars" | "atr14" | "sma20" | "sma50" | "sma200"> | null): boolean {
  if (!signal) return false;
  if (signal.bars.length >= 2) {
    const last = new Date(signal.bars.at(-1)?.timestamp ?? "").getTime();
    const previous = new Date(signal.bars.at(-2)?.timestamp ?? "").getTime();
    const gapHours = (last - previous) / (60 * 60 * 1000);
    if (Number.isFinite(gapHours) && gapHours >= 18) return true;
  }

  return Boolean(signal.atr14 && (signal.sma20 || signal.sma50 || signal.sma200));
}

function isDailyTimeframe(timeframe?: string | null): boolean {
  if (!timeframe) return false;
  return /^(1d|day|daily|1day)$/i.test(timeframe.trim());
}

function getEasternTimeParts(date: Date): { weekday: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  const hour = Number(value("hour"));

  return {
    weekday: value("weekday"),
    hour: hour === 24 ? 0 : hour,
    minute: Number(value("minute"))
  };
}

function formatSignedPct(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}
