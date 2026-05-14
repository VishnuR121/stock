import type { OptionIdea } from "../src/shared/types";
import { round } from "./indicators";

interface RawAlpacaOptionContract {
  symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike_price: string;
  close_price?: string | null;
  bid_price?: string | null;
  ask_price?: string | null;
  last_price?: string | null;
  volume?: string | null;
  open_interest?: string | null;
}

export function mapOptionContractsToIdeas(contracts: RawAlpacaOptionContract[]): OptionIdea[] {
  return contracts
    .map((contract) => {
      const strike = Number(contract.strike_price);
      const close = toPositiveNumber(contract.close_price);
      const bid = toPositiveNumber(contract.bid_price);
      const ask = toPositiveNumber(contract.ask_price);
      const last = toPositiveNumber(contract.last_price);
      const mid = bid !== null && ask !== null && ask >= bid ? round((bid + ask) / 2, 2) : null;
      const volume = toNumberOrNull(contract.volume);
      const openInterest = toNumberOrNull(contract.open_interest);
      const premium = close ?? last ?? mid;
      const spreadWidthPct = getSpreadWidthPct(bid, ask, mid);
      const liquidityScore = getLiquidityScore({ openInterest, volume, spreadWidthPct, premium });
      const breakeven = premium
        ? contract.type === "call"
          ? round(strike + premium, 2)
          : round(strike - premium, 2)
        : null;
      const maxLoss = premium ? round(premium * 100, 2) : null;

      return {
        symbol: contract.symbol,
        underlyingSymbol: contract.underlying_symbol,
        type: contract.type,
        expirationDate: contract.expiration_date,
        strikePrice: strike,
        closePrice: premium,
        bidPrice: bid,
        askPrice: ask,
        midPrice: mid,
        lastPrice: last,
        volume,
        openInterest,
        breakeven,
        maxLoss,
        spreadWidthPct,
        liquidityScore,
        liquidityWarning: getLiquidityWarning({ openInterest, volume, premium, spreadWidthPct })
      };
    })
    .filter((idea) => Number.isFinite(idea.strikePrice))
    .sort((left, right) => left.expirationDate.localeCompare(right.expirationDate) || left.strikePrice - right.strikePrice);
}

export function enrichOptionIdeas(options: OptionIdea[], underlyingPrice: number | null, now = new Date()): OptionIdea[] {
  if (!underlyingPrice || underlyingPrice <= 0) return options;
  return options.map((option) => enrichOptionIdea(option, underlyingPrice, now));
}

export function enrichOptionIdea(option: OptionIdea, underlyingPrice: number, now = new Date()): OptionIdea {
  const daysToExpiration = getDaysToExpiration(option.expirationDate, now);
  const yearsToExpiration = Math.max(daysToExpiration / 365, 1 / 365);
  const premium = option.closePrice;
  const intrinsicValue = getIntrinsicValue(option.type, underlyingPrice, option.strikePrice);
  const extrinsicValue = premium !== null ? Math.max(0, round(premium - intrinsicValue, 2)) : null;
  const moneyness = round((underlyingPrice - option.strikePrice) / underlyingPrice, 4);

  if (!premium || premium <= intrinsicValue || daysToExpiration <= 0) {
    return {
      ...option,
      daysToExpiration,
      moneyness,
      intrinsicValue,
      extrinsicValue,
      probabilityOfProfit: getProbabilityOfProfit(option.type, underlyingPrice, option.breakeven, null, yearsToExpiration)
    };
  }

  const impliedVolatility = solveImpliedVolatility(option.type, underlyingPrice, option.strikePrice, yearsToExpiration, premium);
  const greeks = impliedVolatility
    ? getGreeks(option.type, underlyingPrice, option.strikePrice, yearsToExpiration, impliedVolatility)
    : {};

  return {
    ...option,
    daysToExpiration,
    moneyness,
    intrinsicValue,
    extrinsicValue,
    impliedVolatility,
    probabilityOfProfit: getProbabilityOfProfit(option.type, underlyingPrice, option.breakeven, impliedVolatility, yearsToExpiration),
    ...greeks
  };
}

export function filterOptionIdeas(
  options: OptionIdea[],
  filters: {
    type?: "call" | "put";
    minDte?: number;
    maxDte?: number;
    minStrike?: number;
    maxStrike?: number;
    requirePrice?: boolean;
  }
): OptionIdea[] {
  return options.filter((option) => {
    if (filters.type && option.type !== filters.type) return false;
    if (typeof filters.minDte === "number" && (option.daysToExpiration ?? 0) < filters.minDte) return false;
    if (typeof filters.maxDte === "number" && (option.daysToExpiration ?? 0) > filters.maxDte) return false;
    if (typeof filters.minStrike === "number" && option.strikePrice < filters.minStrike) return false;
    if (typeof filters.maxStrike === "number" && option.strikePrice > filters.maxStrike) return false;
    if (filters.requirePrice && getOptionPrice(option) === null) return false;
    return true;
  });
}

export function getOptionPrice(option?: OptionIdea): number | null {
  if (!option) return null;
  return option.midPrice ?? option.lastPrice ?? option.closePrice ?? null;
}

export function getDebitSpreadMetrics(input: {
  type: "call" | "put";
  longLeg?: OptionIdea;
  shortLeg?: OptionIdea;
}): {
  netDebit: number | null;
  breakeven: number | null;
  maxLoss: number | null;
  maxGain: number | null;
  probabilityOfProfit: number | null;
} {
  const longPremium = input.longLeg?.closePrice;
  const shortPremium = input.shortLeg?.closePrice;
  if (!input.longLeg || !input.shortLeg || longPremium === null || longPremium === undefined || shortPremium === null || shortPremium === undefined) {
    return { netDebit: null, breakeven: null, maxLoss: null, maxGain: null, probabilityOfProfit: null };
  }

  const width = Math.abs(input.shortLeg.strikePrice - input.longLeg.strikePrice);
  const debit = round(Math.max(0, longPremium - shortPremium), 2);
  const maxLoss = round(debit * 100, 2);
  const maxGain = round(Math.max(0, width - debit) * 100, 2);
  const breakeven = input.type === "call"
    ? round(input.longLeg.strikePrice + debit, 2)
    : round(input.longLeg.strikePrice - debit, 2);
  const probabilityOfProfit = input.longLeg.probabilityOfProfit ?? null;
  return { netDebit: debit, breakeven, maxLoss, maxGain, probabilityOfProfit };
}

export function getCoveredCallMetrics(stockPrice: number | null, call?: OptionIdea) {
  if (!stockPrice || !call?.closePrice) {
    return { netCredit: null, breakeven: null, maxLoss: null, maxGain: null, probabilityOfProfit: null };
  }
  const credit = call.closePrice;
  return {
    netCredit: round(credit * 100, 2),
    breakeven: round(stockPrice - credit, 2),
    maxLoss: round(Math.max(0, stockPrice - credit) * 100, 2),
    maxGain: round(Math.max(0, call.strikePrice - stockPrice + credit) * 100, 2),
    probabilityOfProfit: call.probabilityOfProfit !== null && call.probabilityOfProfit !== undefined
      ? round(1 - call.probabilityOfProfit, 4)
      : null
  };
}

export function getCashSecuredPutMetrics(put?: OptionIdea) {
  if (!put?.closePrice) {
    return { netCredit: null, breakeven: null, maxLoss: null, maxGain: null, probabilityOfProfit: null };
  }
  const credit = put.closePrice;
  return {
    netCredit: round(credit * 100, 2),
    breakeven: round(put.strikePrice - credit, 2),
    maxLoss: round(Math.max(0, put.strikePrice - credit) * 100, 2),
    maxGain: round(credit * 100, 2),
    probabilityOfProfit: put.probabilityOfProfit !== null && put.probabilityOfProfit !== undefined
      ? round(1 - put.probabilityOfProfit, 4)
      : null
  };
}

function getLiquidityWarning(input: {
  openInterest: number | null;
  volume: number | null;
  premium: number | null;
  spreadWidthPct: number | null;
}): string | null {
  if (input.premium === null) return "No recent option price available.";
  if (input.spreadWidthPct !== null && input.spreadWidthPct > 0.2) return "Wide bid/ask spread.";
  if (input.openInterest === null) return "Open interest unavailable.";
  if (input.openInterest < 100) return "Low open interest.";
  if (input.volume !== null && input.volume < 10) return "Low option volume.";
  return null;
}

export function getDaysToExpiration(expirationDate: string, now: Date): number {
  const expiration = new Date(`${expirationDate}T21:00:00Z`);
  const days = Math.ceil((expiration.getTime() - now.getTime()) / 86400000);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

function toPositiveNumber(value?: string | null): number | null {
  const parsed = toNumberOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function toNumberOrNull(value?: string | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSpreadWidthPct(bid: number | null, ask: number | null, mid: number | null): number | null {
  if (bid === null || ask === null || mid === null || mid <= 0 || ask < bid) return null;
  return round((ask - bid) / mid, 4);
}

function getLiquidityScore(input: {
  openInterest: number | null;
  volume: number | null;
  spreadWidthPct: number | null;
  premium: number | null;
}): number | null {
  if (input.premium === null) return null;
  let score = 55;
  if ((input.openInterest ?? 0) >= 500) score += 22;
  else if ((input.openInterest ?? 0) >= 100) score += 12;
  else score -= 20;

  if (input.volume !== null) {
    if (input.volume >= 100) score += 12;
    else if (input.volume < 10) score -= 10;
  }

  if (input.spreadWidthPct !== null) {
    if (input.spreadWidthPct <= 0.08) score += 12;
    else if (input.spreadWidthPct > 0.2) score -= 22;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getIntrinsicValue(type: "call" | "put", underlyingPrice: number, strikePrice: number): number {
  return round(Math.max(0, type === "call" ? underlyingPrice - strikePrice : strikePrice - underlyingPrice), 2);
}

function solveImpliedVolatility(type: "call" | "put", stockPrice: number, strikePrice: number, years: number, marketPrice: number): number | null {
  let low = 0.01;
  let high = 5;
  for (let index = 0; index < 80; index += 1) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(type, stockPrice, strikePrice, years, mid);
    if (price > marketPrice) high = mid;
    else low = mid;
  }
  const iv = round((low + high) / 2, 4);
  return Number.isFinite(iv) ? iv : null;
}

function blackScholesPrice(type: "call" | "put", stockPrice: number, strikePrice: number, years: number, volatility: number, riskFreeRate = 0.045): number {
  const d1 = getD1(stockPrice, strikePrice, years, volatility, riskFreeRate);
  const d2 = d1 - volatility * Math.sqrt(years);
  if (type === "call") {
    return stockPrice * normalCdf(d1) - strikePrice * Math.exp(-riskFreeRate * years) * normalCdf(d2);
  }
  return strikePrice * Math.exp(-riskFreeRate * years) * normalCdf(-d2) - stockPrice * normalCdf(-d1);
}

function getGreeks(type: "call" | "put", stockPrice: number, strikePrice: number, years: number, volatility: number, riskFreeRate = 0.045) {
  const d1 = getD1(stockPrice, strikePrice, years, volatility, riskFreeRate);
  const d2 = d1 - volatility * Math.sqrt(years);
  const pdf = normalPdf(d1);
  const delta = type === "call" ? normalCdf(d1) : normalCdf(d1) - 1;
  const gamma = pdf / (stockPrice * volatility * Math.sqrt(years));
  const vega = stockPrice * pdf * Math.sqrt(years) / 100;
  const thetaCall = (
    -(stockPrice * pdf * volatility) / (2 * Math.sqrt(years)) -
    riskFreeRate * strikePrice * Math.exp(-riskFreeRate * years) * normalCdf(d2)
  ) / 365;
  const thetaPut = (
    -(stockPrice * pdf * volatility) / (2 * Math.sqrt(years)) +
    riskFreeRate * strikePrice * Math.exp(-riskFreeRate * years) * normalCdf(-d2)
  ) / 365;
  return {
    delta: round(delta, 4),
    gamma: round(gamma, 4),
    theta: round(type === "call" ? thetaCall : thetaPut, 4),
    vega: round(vega, 4)
  };
}

function getProbabilityOfProfit(type: "call" | "put", stockPrice: number, breakeven: number | null, volatility: number | null, years: number): number | null {
  if (!breakeven || !volatility || volatility <= 0 || years <= 0) return null;
  const z = (Math.log(breakeven / stockPrice) + 0.5 * volatility * volatility * years) / (volatility * Math.sqrt(years));
  return round(type === "call" ? 1 - normalCdf(z) : normalCdf(z), 4);
}

function getD1(stockPrice: number, strikePrice: number, years: number, volatility: number, riskFreeRate: number): number {
  return (Math.log(stockPrice / strikePrice) + (riskFreeRate + 0.5 * volatility * volatility) * years) / (volatility * Math.sqrt(years));
}

function normalPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
