import { describe, expect, it } from "vitest";
import { mapOptionContractsToIdeas } from "../server/options";

describe("options analyzer", () => {
  it("calculates long call and put breakevens and max loss", () => {
    const ideas = mapOptionContractsToIdeas([
      {
        symbol: "AAPL260117C00190000",
        underlying_symbol: "AAPL",
        type: "call",
        expiration_date: "2026-01-17",
        strike_price: "190",
        close_price: "5.25",
        open_interest: "250"
      },
      {
        symbol: "AAPL260117P00180000",
        underlying_symbol: "AAPL",
        type: "put",
        expiration_date: "2026-01-17",
        strike_price: "180",
        close_price: "4.10",
        open_interest: "12"
      }
    ]);

    const call = ideas.find((idea) => idea.type === "call");
    const put = ideas.find((idea) => idea.type === "put");

    expect(call?.breakeven).toBe(195.25);
    expect(call?.maxLoss).toBe(525);
    expect(put?.breakeven).toBe(175.9);
    expect(put?.liquidityWarning).toMatch(/Low open interest/);
  });
});
