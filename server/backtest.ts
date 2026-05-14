import type {
  BacktestEquityPoint,
  BacktestExitReason,
  BacktestRequest,
  BacktestResult,
  BacktestTrade,
  Bar,
  MarketRegimeLabel,
  MarketRegimeSnapshot,
  RiskProfile,
  RiskSettings
} from "../src/shared/types";
import { buildSignalSnapshot, getDefaultRiskProfile, round } from "./indicators";
import { buildMarketRegimeSnapshot } from "./marketRegime";
import { rankSignalSnapshot } from "./ranking";

interface RunBacktestInput {
  request: BacktestRequest;
  barsBySymbol: Record<string, Bar[]>;
  benchmarkBars: Bar[];
  qqqBars?: Bar[];
  riskSettings: Pick<RiskSettings, "maxRiskPerTradePct" | "maxPositionPct" | "minRiskReward" | "maxDataAgeMinutes">;
  now?: Date;
}

interface OpenBacktestPosition {
  symbol: string;
  entryDate: string;
  entryIndex: number;
  entryPrice: number;
  quantity: number;
  stopLossPrice: number;
  targetPrice: number;
  entryScore: number;
  riskDollars: number;
}

const MIN_HISTORY_BARS = 60;

export function runBacktest(input: RunBacktestInput): BacktestResult {
  const request = normalizeBacktestRequest(input.request);
  const initialEquity = request.initialEquity ?? 100000;
  const riskProfile = buildBacktestRiskProfile(initialEquity, request, input.riskSettings);
  const symbols = request.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  const calendar = getBacktestCalendar(input.benchmarkBars, request.startDate, request.endDate);
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  const openPositions: OpenBacktestPosition[] = [];
  const qqqBars = input.qqqBars ?? input.barsBySymbol.QQQ ?? input.benchmarkBars;
  const regimeCache = new Map<string, MarketRegimeSnapshot | null>();
  let realizedPnl = 0;
  let highWaterMark = initialEquity;

  if (!calendar.length) warnings.push("No benchmark bars were available inside the requested backtest window.");
  if (request.marketRegimeFilter?.length && qqqBars === input.benchmarkBars) {
    warnings.push("QQQ historical bars were unavailable; SPY bars were reused for QQQ regime confirmation.");
  }

  for (const date of calendar) {
    const regime = getHistoricalMarketRegime(input.benchmarkBars, qqqBars, date, regimeCache);
    for (let index = openPositions.length - 1; index >= 0; index -= 1) {
      const position = openPositions[index];
      const bars = input.barsBySymbol[position.symbol] ?? [];
      const barIndex = findBarIndexOnOrBefore(bars, date);
      if (barIndex < position.entryIndex || barIndex === -1) continue;
      const bar = bars[barIndex];
      const exit = getExit(position, bars, barIndex, request, riskProfile, input.riskSettings, regime);
      if (!exit) continue;

      const trade = closePosition(position, exit.price, exit.date, exit.reason);
      trades.push(trade);
      realizedPnl += trade.pnl;
      openPositions.splice(index, 1);
    }

    const equity = round(initialEquity + realizedPnl + getOpenUnrealizedPnl(openPositions, input.barsBySymbol, date), 2);
    highWaterMark = Math.max(highWaterMark, equity);
    const benchmarkEquity = getBenchmarkEquity(input.benchmarkBars, request.startDate, date, initialEquity);
    equityCurve.push({
      date,
      equity,
      benchmarkEquity,
      drawdownPct: highWaterMark > 0 ? round(((equity - highWaterMark) / highWaterMark) * 100, 2) : 0
    });

    const slots = request.maxPositions - openPositions.length;
    if (slots <= 0) continue;
    if (!isRegimeAllowedForEntry(regime, request.marketRegimeFilter)) continue;

    const candidates = symbols
      .filter((symbol) => !openPositions.some((position) => position.symbol === symbol))
      .map((symbol) => buildEntryCandidate(symbol, input.barsBySymbol[symbol] ?? [], date, request, riskProfile, input.riskSettings))
      .filter((candidate): candidate is OpenBacktestPosition => Boolean(candidate))
      .sort((left, right) => right.entryScore - left.entryScore || left.symbol.localeCompare(right.symbol))
      .slice(0, slots);

    openPositions.push(...candidates);
  }

  const lastDate = calendar.at(-1);
  if (lastDate) {
    for (const position of [...openPositions]) {
      const bars = input.barsBySymbol[position.symbol] ?? [];
      const barIndex = findBarIndexOnOrBefore(bars, lastDate);
      const exitBar = bars[barIndex];
      if (!exitBar) continue;
      const trade = closePosition(position, exitBar.close, toDateKey(exitBar.timestamp), "end_of_data");
      trades.push(trade);
      realizedPnl += trade.pnl;
    }
  }

  const finalEquity = equityCurve.at(-1)?.equity ?? initialEquity;
  const totalReturnPct = round(((finalEquity - initialEquity) / initialEquity) * 100, 2);
  const benchmarkReturnPct = getBenchmarkReturn(input.benchmarkBars, request.startDate, request.endDate);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    request,
    totalReturnPct,
    annualizedReturnPct: getAnnualizedReturnPct(totalReturnPct, request.startDate, request.endDate),
    winRate: getWinRate(trades),
    averageWin: getAverageWin(trades),
    averageLoss: getAverageLoss(trades),
    maxDrawdownPct: equityCurve.reduce((min, point) => Math.min(min, point.drawdownPct), 0),
    numberOfTrades: trades.length,
    profitFactor: getProfitFactor(trades),
    benchmarkReturnPct,
    equityCurve,
    trades,
    warnings
  };
}

function buildEntryCandidate(
  symbol: string,
  bars: Bar[],
  date: string,
  request: BacktestRequest,
  riskProfile: RiskProfile,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">
): OpenBacktestPosition | null {
  const decisionIndex = findBarIndexOnOrBefore(bars, date);
  const entryIndex = decisionIndex + 1;
  if (decisionIndex < MIN_HISTORY_BARS || entryIndex >= bars.length) return null;

  const history = bars.slice(0, decisionIndex + 1);
  const snapshot = buildSignalSnapshot(symbol, history, riskProfile);
  const ranking = rankSignalSnapshot({
    snapshot,
    riskSettings,
    now: new Date(`${date}T21:00:00.000Z`)
  });

  if (ranking.adjustedScore < request.minScore || ranking.action === "avoid") return null;
  if (!snapshot.suggestedStop || !snapshot.suggestedTarget) return null;

  const entryBar = bars[entryIndex];
  const entryPrice = entryBar.open;
  const stopLossPrice = snapshot.suggestedStop;
  const targetPrice = snapshot.suggestedTarget;
  if (stopLossPrice >= entryPrice || targetPrice <= entryPrice) return null;

  const riskPerShare = entryPrice - stopLossPrice;
  const maxRiskDollars = riskProfile.accountEquity * riskProfile.maxRiskPerTradePct;
  const maxNotional = riskProfile.accountEquity * riskProfile.maxPositionPct;
  const quantity = Math.max(0, Math.min(Math.floor(maxRiskDollars / riskPerShare), Math.floor(maxNotional / entryPrice)));
  if (quantity <= 0) return null;

  return {
    symbol,
    entryDate: toDateKey(entryBar.timestamp),
    entryIndex,
    entryPrice: round(entryPrice, 2),
    quantity,
    stopLossPrice: round(stopLossPrice, 2),
    targetPrice: round(targetPrice, 2),
    entryScore: ranking.adjustedScore,
    riskDollars: round(quantity * riskPerShare, 2)
  };
}

function getExit(
  position: OpenBacktestPosition,
  bars: Bar[],
  barIndex: number,
  request: BacktestRequest,
  riskProfile: RiskProfile,
  riskSettings: Pick<RiskSettings, "minRiskReward" | "maxDataAgeMinutes">,
  marketRegime: MarketRegimeSnapshot | null
): { price: number; date: string; reason: BacktestExitReason } | null {
  const bar = bars[barIndex];
  const date = toDateKey(bar.timestamp);
  if (bar.low <= position.stopLossPrice) return { price: position.stopLossPrice, date, reason: "stop" };
  if (bar.high >= position.targetPrice) return { price: position.targetPrice, date, reason: "target" };
  if (barIndex - position.entryIndex + 1 >= request.holdingPeriodDays) return { price: bar.close, date, reason: "holding_period" };
  if (marketRegime?.regime === "bearish") return { price: bar.close, date, reason: "market_regime" };

  const history = bars.slice(0, barIndex + 1);
  if (history.length >= MIN_HISTORY_BARS) {
    const snapshot = buildSignalSnapshot(position.symbol, history, riskProfile);
    const ranking = rankSignalSnapshot({
      snapshot,
      riskSettings,
      now: new Date(`${date}T21:00:00.000Z`)
    });
    if (ranking.adjustedScore <= request.minScore - 20) return { price: bar.close, date, reason: "score_drop" };
  }

  return null;
}

function isRegimeAllowedForEntry(
  marketRegime: MarketRegimeSnapshot | null,
  filter?: MarketRegimeLabel[]
): boolean {
  if (!filter?.length) return true;
  if (!marketRegime) return false;
  return filter.includes(marketRegime.regime);
}

function getHistoricalMarketRegime(
  spyBars: Bar[],
  qqqBars: Bar[],
  date: string,
  cache: Map<string, MarketRegimeSnapshot | null>
): MarketRegimeSnapshot | null {
  if (cache.has(date)) return cache.get(date) ?? null;
  const spyIndex = findBarIndexOnOrBefore(spyBars, date);
  const qqqIndex = findBarIndexOnOrBefore(qqqBars, date);
  if (spyIndex < MIN_HISTORY_BARS || qqqIndex < MIN_HISTORY_BARS) {
    cache.set(date, null);
    return null;
  }

  const snapshot = buildMarketRegimeSnapshot({
    spyBars: spyBars.slice(0, spyIndex + 1),
    qqqBars: qqqBars.slice(0, qqqIndex + 1),
    now: new Date(`${date}T21:00:00.000Z`)
  });
  cache.set(date, snapshot);
  return snapshot;
}

function closePosition(position: OpenBacktestPosition, exitPrice: number, exitDate: string, exitReason: BacktestExitReason): BacktestTrade {
  const pnl = round((exitPrice - position.entryPrice) * position.quantity, 2);
  return {
    id: `bt-${position.symbol}-${position.entryDate}-${exitDate}`,
    symbol: position.symbol,
    side: "long",
    entryDate: position.entryDate,
    exitDate,
    entryPrice: position.entryPrice,
    exitPrice: round(exitPrice, 2),
    quantity: position.quantity,
    stopLossPrice: position.stopLossPrice,
    targetPrice: position.targetPrice,
    entryScore: position.entryScore,
    exitReason,
    pnl,
    pnlPct: round(((exitPrice - position.entryPrice) / position.entryPrice) * 100, 2),
    rMultiple: position.riskDollars > 0 ? round(pnl / position.riskDollars, 2) : 0,
    riskDollars: position.riskDollars
  };
}

function normalizeBacktestRequest(request: BacktestRequest): BacktestRequest {
  return {
    ...request,
    symbols: [...new Set(request.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 25),
    holdingPeriodDays: Math.max(1, Math.min(Math.round(request.holdingPeriodDays || 10), 60)),
    maxPositions: Math.max(1, Math.min(Math.round(request.maxPositions || 3), 20)),
    minScore: Math.max(1, Math.min(Math.round(request.minScore || 70), 100)),
    initialEquity: request.initialEquity && request.initialEquity > 0 ? request.initialEquity : 100000
  };
}

function buildBacktestRiskProfile(
  equity: number,
  request: BacktestRequest,
  riskSettings: Pick<RiskSettings, "maxRiskPerTradePct" | "maxPositionPct" | "minRiskReward">
): RiskProfile {
  return {
    ...getDefaultRiskProfile(equity),
    maxRiskPerTradePct: request.riskPerTradePct ?? riskSettings.maxRiskPerTradePct,
    maxPositionPct: request.maxPositionPct ?? riskSettings.maxPositionPct,
    minRiskReward: request.minRiskReward ?? riskSettings.minRiskReward
  };
}

function getBacktestCalendar(benchmarkBars: Bar[], startDate: string, endDate: string): string[] {
  return benchmarkBars
    .map((bar) => toDateKey(bar.timestamp))
    .filter((date) => date >= startDate && date <= endDate);
}

function findBarIndexOnOrBefore(bars: Bar[], date: string): number {
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (toDateKey(bars[index].timestamp) <= date) return index;
  }
  return -1;
}

function getOpenUnrealizedPnl(openPositions: OpenBacktestPosition[], barsBySymbol: Record<string, Bar[]>, date: string): number {
  return openPositions.reduce((sum, position) => {
    if (date < position.entryDate) return sum;
    const bars = barsBySymbol[position.symbol] ?? [];
    const bar = bars[findBarIndexOnOrBefore(bars, date)];
    return bar ? sum + (bar.close - position.entryPrice) * position.quantity : sum;
  }, 0);
}

function getBenchmarkEquity(benchmarkBars: Bar[], startDate: string, date: string, initialEquity: number): number | null {
  const startBar = benchmarkBars.find((bar) => toDateKey(bar.timestamp) >= startDate);
  const currentBar = benchmarkBars[findBarIndexOnOrBefore(benchmarkBars, date)];
  if (!startBar || !currentBar || startBar.close <= 0) return null;
  return round(initialEquity * (currentBar.close / startBar.close), 2);
}

function getBenchmarkReturn(benchmarkBars: Bar[], startDate: string, endDate: string): number | null {
  const startBar = benchmarkBars.find((bar) => toDateKey(bar.timestamp) >= startDate);
  const endBar = benchmarkBars[findBarIndexOnOrBefore(benchmarkBars, endDate)];
  if (!startBar || !endBar || startBar.close <= 0) return null;
  return round(((endBar.close - startBar.close) / startBar.close) * 100, 2);
}

function getAnnualizedReturnPct(totalReturnPct: number, startDate: string, endDate: string): number | null {
  const days = (new Date(`${endDate}T00:00:00.000Z`).getTime() - new Date(`${startDate}T00:00:00.000Z`).getTime()) / 86400000;
  if (!Number.isFinite(days) || days <= 0) return null;
  return round((Math.pow(1 + totalReturnPct / 100, 365 / days) - 1) * 100, 2);
}

function getWinRate(trades: BacktestTrade[]): number {
  if (!trades.length) return 0;
  return round((trades.filter((trade) => trade.pnl > 0).length / trades.length) * 100, 2);
}

function getAverageWin(trades: BacktestTrade[]): number {
  const wins = trades.filter((trade) => trade.pnl > 0);
  if (!wins.length) return 0;
  return round(wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length, 2);
}

function getAverageLoss(trades: BacktestTrade[]): number {
  const losses = trades.filter((trade) => trade.pnl < 0);
  if (!losses.length) return 0;
  return round(losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length, 2);
}

function getProfitFactor(trades: BacktestTrade[]): number | null {
  const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  if (grossLoss === 0) return grossProfit > 0 ? null : 0;
  return round(grossProfit / grossLoss, 2);
}

function toDateKey(value: string): string {
  return value.slice(0, 10);
}
