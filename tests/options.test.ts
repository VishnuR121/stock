import { describe, expect, it } from "vitest";
import { enrichOptionIdeas, getDebitSpreadMetrics, mapOptionContractsToIdeas } from "../server/options";

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

  it("estimates option analytics and debit spread risk/reward", () => {
    const ideas = enrichOptionIdeas(mapOptionContractsToIdeas([
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
        symbol: "AAPL260117C00195000",
        underlying_symbol: "AAPL",
        type: "call",
        expiration_date: "2026-01-17",
        strike_price: "195",
        close_price: "3.10",
        open_interest: "220"
      }
    ]), 188, new Date("2025-12-17T16:00:00Z"));

    expect(ideas[0].impliedVolatility).toBeGreaterThan(0);
    expect(ideas[0].delta).toBeGreaterThan(0);
    expect(ideas[0].probabilityOfProfit).toBeGreaterThan(0);

    const spread = getDebitSpreadMetrics({ type: "call", longLeg: ideas[0], shortLeg: ideas[1] });
    expect(spread.netDebit).toBe(2.15);
    expect(spread.maxLoss).toBe(215);
    expect(spread.maxGain).toBe(285);
    expect(spread.breakeven).toBe(192.15);
  });
});
