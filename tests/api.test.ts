// @vitest-environment node
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";

describe("API safety behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports live Alpaca URLs as unsafe", async () => {
    const app = createApp({
      alpacaPaperBaseUrl: "https://api.alpaca.markets",
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      dataFilePath: "data/test-health.json"
    });

    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.alpacaPaperOnly).toBe(false);
  });

  it("blocks account calls when the Alpaca URL is not paper", async () => {
    const app = createApp({
      alpacaPaperBaseUrl: "https://api.alpaca.markets",
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      dataFilePath: "data/test-live-block.json"
    });

    const response = await request(app).get("/api/alpaca/account").expect(500);
    expect(response.body.error).toMatch(/live trading URL is blocked/);
  });

  it("returns 503 when paper credentials are missing", async () => {
    const app = createApp({
      alpacaKeyId: undefined,
      alpacaSecretKey: undefined,
      dataFilePath: "data/test-missing-creds.json"
    });

    const response = await request(app).get("/api/alpaca/account").expect(503);
    expect(response.body.error).toMatch(/credentials are not configured/);
  });

  it("rejects unsafe paper orders before submission", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v2/account")) {
        return jsonResponse({
          equity: "100000",
          cash: "100000",
          buying_power: "200000",
          portfolio_value: "100000",
          status: "ACTIVE",
          currency: "USD"
        });
      }
      if (target.includes("/v2/stocks/SPY/bars")) {
        return jsonResponse({
          bars: [
            { t: "2026-01-01T00:00:00Z", o: 99, h: 101, l: 98, c: 100, v: 1000 }
          ]
        });
      }
      return jsonResponse({ id: "unexpected" });
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      dataFilePath: "data/test-order-reject.json"
    });

    const response = await request(app)
      .post("/api/alpaca/paper-orders")
      .send({
        symbol: "SPY",
        orderType: "market",
        quantity: 1,
        stopLossPrice: 95,
        takeProfitPrice: 110,
        timeInForce: "day",
        earningsChecked: false,
        confirmedPaperOnly: true,
        acceptedRisk: true
      })
      .expect(400);

    expect(response.body.errors.join(" ")).toMatch(/earnings/);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v2/orders"), expect.anything());
  });
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    })
  );
}
