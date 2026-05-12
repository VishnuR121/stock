import type {
  AlgoTradeProposal,
  MonitoredPosition,
  PositionMonitorSnapshot
} from "../src/shared/types";

const OPTION_TAKE_PROFIT_PCT = 0.5;
const OPTION_STOP_LOSS_PCT = -0.35;
const OPTION_CLOSE_DTE = 7;

interface AlpacaPositionLike {
  symbol?: string;
  asset_class?: string;
  side?: string;
  qty?: string | number;
  avg_entry_price?: string | number;
  current_price?: string | number;
  market_value?: string | number;
  unrealized_pl?: string | number;
  unrealized_plpc?: string | number;
  cost_basis?: string | number;
}

export function buildPositionMonitorSnapshot(input: {
  positions: unknown[];
  openOrders: unknown[];
  proposals: AlgoTradeProposal[];
  now?: Date;
}): PositionMonitorSnapshot {
  const now = input.now ?? new Date();
  const monitored = input.positions.map((position) => monitorPosition(position, input.proposals, now));
  const totalUnrealizedPl = monitored.every((position) => position.unrealizedPl === null)
    ? null
    : monitored.reduce((sum, position) => sum + (position.unrealizedPl ?? 0), 0);

  return {
    generatedAt: now.toISOString(),
    positions: monitored,
    openOrders: input.openOrders,
    summary: {
      totalPositions: monitored.length,
      exitsSuggested: monitored.filter((position) => position.urgency === "exit").length,
      watchCount: monitored.filter((position) => position.urgency === "watch").length,
      totalUnrealizedPl
    }
  };
}

function monitorPosition(raw: unknown, proposals: AlgoTradeProposal[], now: Date): MonitoredPosition {
  const position = raw as AlpacaPositionLike;
  const symbol = String(position.symbol ?? "");
  const proposal = matchProposal(symbol, proposals);
  const optionDetails = parseOptionSymbol(symbol);
  const currentPrice = toNumber(position.current_price);
  const side = normalizeSide(position.side);
  const reasons: string[] = [];
  let urgency: MonitoredPosition["urgency"] = "hold";
  let suggestedAction = "Hold and monitor.";

  const stopLossPrice = proposal?.order?.stopLossPrice;
  const takeProfitPrice = proposal?.order?.takeProfitPrice;
  const pnlPct = toNumber(position.unrealized_plpc);

  if (proposal?.executionType === "long_option" || optionDetails) {
    const daysToExpiration = optionDetails?.expirationDate ? getDaysToExpiration(optionDetails.expirationDate, now) : undefined;
    if (pnlPct !== null && pnlPct >= OPTION_TAKE_PROFIT_PCT) {
      urgency = "exit";
      reasons.push(`Option profit is ${formatPercent(pnlPct)}, at or above the ${formatPercent(OPTION_TAKE_PROFIT_PCT)} take-profit rule.`);
    }
    if (pnlPct !== null && pnlPct <= OPTION_STOP_LOSS_PCT) {
      urgency = "exit";
      reasons.push(`Option loss is ${formatPercent(pnlPct)}, at or below the ${formatPercent(OPTION_STOP_LOSS_PCT)} stop-loss rule.`);
    }
    if (typeof daysToExpiration === "number" && daysToExpiration <= OPTION_CLOSE_DTE) {
      urgency = "exit";
      reasons.push(`Option has ${daysToExpiration} DTE, at or below the ${OPTION_CLOSE_DTE}-day close rule.`);
    }
    if (urgency !== "exit" && typeof daysToExpiration === "number" && daysToExpiration <= OPTION_CLOSE_DTE + 7) {
      urgency = "watch";
      reasons.push(`Option has ${daysToExpiration} DTE; prepare an exit plan.`);
    }
    suggestedAction = urgency === "exit"
      ? "Close the option position from the monitor unless you intentionally override the rule."
      : "Keep monitoring option P/L and days to expiration.";

    return {
      symbol,
      assetClass: position.asset_class,
      side,
      quantity: toNumber(position.qty),
      avgEntryPrice: toNumber(position.avg_entry_price),
      currentPrice,
      marketValue: toNumber(position.market_value),
      unrealizedPl: toNumber(position.unrealized_pl),
      unrealizedPlPct: pnlPct,
      costBasis: toNumber(position.cost_basis),
      matchedProposalId: proposal?.id,
      strategyKind: proposal?.strategyKind,
      executionType: proposal?.executionType ?? "long_option",
      optionExpirationDate: optionDetails?.expirationDate,
      daysToExpiration,
      urgency,
      suggestedAction,
      reasons: reasons.length ? reasons : ["No option exit rule has triggered yet."]
    };
  }

  if (currentPrice !== null && stopLossPrice !== undefined && takeProfitPrice !== undefined) {
    const isShort = proposal?.executionType === "short_stock_bracket" || side === "short";
    const stopHit = isShort ? currentPrice >= stopLossPrice : currentPrice <= stopLossPrice;
    const targetHit = isShort ? currentPrice <= takeProfitPrice : currentPrice >= takeProfitPrice;
    if (stopHit) {
      urgency = "exit";
      reasons.push("Current price has reached or crossed the stored stop level.");
    }
    if (targetHit) {
      urgency = "exit";
      reasons.push("Current price has reached or crossed the stored target level.");
    }
    if (urgency !== "exit") {
      reasons.push("Stored stop/target levels have not triggered.");
    }
    suggestedAction = urgency === "exit"
      ? "Close the position or confirm Alpaca bracket exits are active."
      : "Hold while the stop/target bracket remains active.";
  } else {
    urgency = "watch";
    reasons.push("No stored stop/target proposal was matched; monitor manually.");
    suggestedAction = "Review this position manually because the app cannot match a complete exit plan.";
  }

  return {
    symbol,
    assetClass: position.asset_class,
    side,
    quantity: toNumber(position.qty),
    avgEntryPrice: toNumber(position.avg_entry_price),
    currentPrice,
    marketValue: toNumber(position.market_value),
    unrealizedPl: toNumber(position.unrealized_pl),
    unrealizedPlPct: pnlPct,
    costBasis: toNumber(position.cost_basis),
    matchedProposalId: proposal?.id,
    strategyKind: proposal?.strategyKind,
    executionType: proposal?.executionType,
    stopLossPrice,
    takeProfitPrice,
    urgency,
    suggestedAction,
    reasons
  };
}

function matchProposal(symbol: string, proposals: AlgoTradeProposal[]): AlgoTradeProposal | undefined {
  const placed = proposals.filter((proposal) => proposal.status === "placed");
  return placed.find((proposal) => proposal.optionOrder?.contractSymbol === symbol)
    ?? placed.find((proposal) => proposal.symbol === symbol && proposal.executionType !== "long_option");
}

function parseOptionSymbol(symbol: string): { expirationDate: string } | null {
  const match = /^(.+?)(\d{6})([CP])(\d{8})$/.exec(symbol);
  if (!match) return null;
  const [, , yymmdd] = match;
  const year = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (!month || !day) return null;
  const fullYear = year >= 70 ? 1900 + year : 2000 + year;
  return {
    expirationDate: `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  };
}

function getDaysToExpiration(expirationDate: string, now: Date): number {
  const expiration = new Date(`${expirationDate}T21:00:00.000Z`);
  return Math.ceil((expiration.getTime() - now.getTime()) / 86400000);
}

function normalizeSide(value: unknown): "long" | "short" {
  return String(value ?? "").toLowerCase() === "short" ? "short" : "long";
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}
