import type { Bar, MarketRegimeComponent, MarketRegimeLabel, MarketRegimeSnapshot } from "../src/shared/types";
import { atr, round, sma } from "./indicators";

interface BuildMarketRegimeInput {
  spyBars: Bar[];
  qqqBars: Bar[];
  now?: Date;
}

const COMPONENT_WEIGHTS: Record<string, number> = {
  SPY: 0.55,
  QQQ: 0.45
};

export function buildMarketRegimeSnapshot(input: BuildMarketRegimeInput): MarketRegimeSnapshot {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const components = [
    buildRegimeComponent("SPY", input.spyBars),
    buildRegimeComponent("QQQ", input.qqqBars)
  ];
  const score = getWeightedScore(components);
  const regime = classifyRegime(score, components);
  const warnings = buildRegimeWarnings(regime, components);

  return {
    regime,
    score,
    explanation: buildExplanation(regime, score, components),
    riskAdjustmentMultiplier: getRiskAdjustmentMultiplier(regime, score),
    warnings,
    generatedAt,
    components
  };
}

export function buildRegimeComponent(symbol: string, bars: Bar[]): MarketRegimeComponent {
  const closes = bars.map((bar) => bar.close);
  const latest = bars.at(-1);
  const price = latest?.close ?? null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const momentum20Pct = getMomentumPct(closes, 20);
  const momentum60Pct = getMomentumPct(closes, 60);
  const drawdownFromHighPct = getDrawdownFromHighPct(bars, 60);
  const atr14 = atr(bars, 14);
  const atrPct = price && atr14 ? round((atr14 / price) * 100, 2) : null;
  const warnings = buildComponentWarnings(bars, price, sma20, sma50, sma200, momentum20Pct, momentum60Pct, drawdownFromHighPct, atrPct);

  return {
    symbol,
    price,
    sma20,
    sma50,
    sma200,
    momentum20Pct,
    momentum60Pct,
    drawdownFromHighPct,
    atrPct,
    score: scoreComponent({ price, sma20, sma50, sma200, momentum20Pct, momentum60Pct, drawdownFromHighPct, atrPct, bars }),
    warnings
  };
}

function scoreComponent(input: {
  price: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  momentum20Pct: number | null;
  momentum60Pct: number | null;
  drawdownFromHighPct: number | null;
  atrPct: number | null;
  bars: Bar[];
}): number {
  if (input.bars.length < 60 || !input.price) return 35;

  let score = 50;
  score += comparePriceToAverage(input.price, input.sma20, 8);
  score += comparePriceToAverage(input.price, input.sma50, 12);
  score += comparePriceToAverage(input.price, input.sma200, 16);

  if (input.sma20 && input.sma50 && input.sma200) {
    if (input.sma20 > input.sma50 && input.sma50 > input.sma200) score += 8;
    if (input.sma20 < input.sma50 && input.sma50 < input.sma200) score -= 8;
  }

  score += scoreMomentum(input.momentum20Pct, { strong: 2, weak: 0, danger: -3 }, { strong: 8, weak: 3, danger: -8, soft: -3 });
  score += scoreMomentum(input.momentum60Pct, { strong: 5, weak: 0, danger: -8 }, { strong: 8, weak: 3, danger: -10, soft: -4 });

  if (input.drawdownFromHighPct !== null) {
    if (input.drawdownFromHighPct <= -12) score -= 14;
    else if (input.drawdownFromHighPct <= -8) score -= 8;
    else if (input.drawdownFromHighPct <= -5) score -= 4;
  }

  if (input.atrPct !== null) {
    if (input.atrPct >= 6) score -= 10;
    else if (input.atrPct >= 4) score -= 6;
    else if (input.atrPct >= 1 && input.atrPct <= 3) score += 4;
  }

  return clampScore(score);
}

function comparePriceToAverage(price: number, average: number | null, weight: number): number {
  if (!average) return -Math.round(weight / 2);
  return price > average ? weight : -weight;
}

function scoreMomentum(
  value: number | null,
  thresholds: { strong: number; weak: number; danger: number },
  points: { strong: number; weak: number; danger: number; soft: number }
): number {
  if (value === null) return -2;
  if (value >= thresholds.strong) return points.strong;
  if (value >= thresholds.weak) return points.weak;
  if (value <= thresholds.danger) return points.danger;
  return points.soft;
}

function getMomentumPct(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const current = closes.at(-1);
  const prior = closes.at(-lookback - 1);
  if (!current || !prior) return null;
  return round(((current - prior) / prior) * 100, 2);
}

function getDrawdownFromHighPct(bars: Bar[], lookback: number): number | null {
  const recent = bars.slice(-lookback);
  const current = recent.at(-1)?.close;
  if (!recent.length || !current) return null;
  const high = Math.max(...recent.map((bar) => bar.high));
  if (!Number.isFinite(high) || high <= 0) return null;
  return round(((current - high) / high) * 100, 2);
}

function getWeightedScore(components: MarketRegimeComponent[]): number {
  const weighted = components.reduce((sum, component) => {
    return sum + component.score * (COMPONENT_WEIGHTS[component.symbol] ?? 0.5);
  }, 0);
  return clampScore(weighted);
}

function classifyRegime(score: number, components: MarketRegimeComponent[]): MarketRegimeLabel {
  const bearishCount = components.filter((component) => component.score <= 42).length;
  const bullishCount = components.filter((component) => component.score >= 68).length;
  const highVolCount = components.filter((component) => (component.atrPct ?? 0) >= 4).length;
  const deepDrawdownCount = components.filter((component) => (component.drawdownFromHighPct ?? 0) <= -8).length;

  if (score <= 42 || bearishCount === components.length) return "bearish";
  if (highVolCount > 0 || deepDrawdownCount > 0 || score < 58) return "caution";
  if (score >= 70 && bullishCount === components.length) return "bullish";
  return "neutral";
}

function getRiskAdjustmentMultiplier(regime: MarketRegimeLabel, score: number): number {
  if (regime === "bullish") return 1;
  if (regime === "neutral") return score >= 65 ? 0.85 : 0.75;
  if (regime === "caution") return 0.5;
  return 0.25;
}

function buildComponentWarnings(
  bars: Bar[],
  price: number | null,
  sma20: number | null,
  sma50: number | null,
  sma200: number | null,
  momentum20Pct: number | null,
  momentum60Pct: number | null,
  drawdownFromHighPct: number | null,
  atrPct: number | null
): string[] {
  const warnings: string[] = [];
  if (bars.length < 200) warnings.push("Less than 200 daily bars; long-term moving-average confirmation is limited.");
  if (!price || !sma20 || !sma50 || !sma200) warnings.push("Missing one or more key price or moving-average inputs.");
  if (price && sma50 && price < sma50) warnings.push("Price is below the 50-day moving average.");
  if (price && sma200 && price < sma200) warnings.push("Price is below the 200-day moving average.");
  if ((momentum20Pct ?? 0) < 0) warnings.push("20-day momentum is negative.");
  if ((momentum60Pct ?? 0) < 0) warnings.push("60-day momentum is negative.");
  if ((drawdownFromHighPct ?? 0) <= -8) warnings.push("Drawdown from the recent high is elevated.");
  if ((atrPct ?? 0) >= 4) warnings.push("ATR volatility is elevated.");
  return warnings;
}

function buildRegimeWarnings(regime: MarketRegimeLabel, components: MarketRegimeComponent[]): string[] {
  const warnings = components.flatMap((component) => component.warnings.map((warning) => `${component.symbol}: ${warning}`));
  if (regime === "bearish") warnings.unshift("Bearish regime: avoid weak long setups and reduce exposure.");
  if (regime === "caution") warnings.unshift("Caution regime: require stronger setups and smaller sizing.");
  if (regime === "neutral") warnings.unshift("Neutral regime: reduce size and require cleaner risk/reward.");
  return [...new Set(warnings)].slice(0, 8);
}

function buildExplanation(regime: MarketRegimeLabel, score: number, components: MarketRegimeComponent[]): string {
  const summary = components
    .map((component) => `${component.symbol} ${component.score}/100`)
    .join(", ");
  if (regime === "bullish") return `Broad-market trend is supportive (${summary}); normal high-quality long setups can be researched.`;
  if (regime === "neutral") return `Broad-market confirmation is mixed (${summary}); favor selective setups with reduced size.`;
  if (regime === "bearish") return `Broad-market risk is elevated (${summary}); weak long setups should be avoided.`;
  return `Market conditions call for caution (${summary}, composite ${score}/100); require stronger confirmation and smaller sizing.`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
