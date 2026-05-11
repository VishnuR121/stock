import type { OptionIdea } from "../src/shared/types";
import { round } from "./indicators";

interface RawAlpacaOptionContract {
  symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike_price: string;
  close_price?: string | null;
  open_interest?: string | null;
}

export function mapOptionContractsToIdeas(contracts: RawAlpacaOptionContract[]): OptionIdea[] {
  return contracts
    .map((contract) => {
      const strike = Number(contract.strike_price);
      const close = contract.close_price ? Number(contract.close_price) : null;
      const openInterest = contract.open_interest ? Number(contract.open_interest) : null;
      const premium = close && close > 0 ? close : null;
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
        openInterest,
        breakeven,
        maxLoss,
        liquidityWarning: getLiquidityWarning(openInterest, premium)
      };
    })
    .filter((idea) => Number.isFinite(idea.strikePrice))
    .sort((left, right) => left.expirationDate.localeCompare(right.expirationDate) || left.strikePrice - right.strikePrice);
}

function getLiquidityWarning(openInterest: number | null, premium: number | null): string | null {
  if (premium === null) return "No recent close price available.";
  if (openInterest === null) return "Open interest unavailable.";
  if (openInterest < 100) return "Low open interest.";
  return null;
}
