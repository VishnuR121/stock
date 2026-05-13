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
      databaseUrl: undefined,
      dataFilePath: "data/test-health.json"
    });

    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.alpacaPaperOnly).toBe(false);
  });

  it("reports the selected Anthropic AI provider", async () => {
    const app = createApp({
      aiProvider: "anthropic",
      anthropicApiKey: "anthropic-key",
      anthropicModel: "claude-test-model",
      openAiApiKey: undefined,
      databaseUrl: undefined,
      dataFilePath: "data/test-anthropic-health.json"
    });

    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.aiProvider).toBe("anthropic");
    expect(response.body.aiConfigured).toBe(true);
    expect(response.body.aiModel).toBe("claude-test-model");
    expect(response.body.openAiConfigured).toBe(false);
    expect(response.body.anthropicConfigured).toBe(true);
  });

  it("blocks account calls when the Alpaca URL is not paper", async () => {
    const app = createApp({
      alpacaPaperBaseUrl: "https://api.alpaca.markets",
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: "data/test-live-block.json"
    });

    const response = await request(app).get("/api/alpaca/account").expect(500);
    expect(response.body.error).toMatch(/live trading URL is blocked/);
  });

  it("returns 503 when paper credentials are missing", async () => {
    const app = createApp({
      alpacaKeyId: undefined,
      alpacaSecretKey: undefined,
      databaseUrl: undefined,
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
      databaseUrl: undefined,
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

  it("kill switch blocks paper orders before broker calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({}));
    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-kill-switch-${Date.now()}.json`
    });

    await request(app).post("/api/settings/risk").send({ killSwitchEnabled: true }).expect(200);

    const response = await request(app)
      .post("/api/alpaca/paper-orders")
      .send({
        symbol: "SPY",
        orderType: "market",
        quantity: 1,
        stopLossPrice: 95,
        takeProfitPrice: 101,
        timeInForce: "day",
        horizon: "intraday",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      })
      .expect(423);

    expect(response.body.errors.join(" ")).toMatch(/kill switch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes a single paper position after explicit confirmation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.includes("/v2/positions/XLI") && init?.method === "DELETE") {
        return jsonResponse({ id: "close-order", symbol: "XLI" });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-close-position-${Date.now()}.json`
    });

    await request(app)
      .post("/api/alpaca/paper-positions/XLI/close")
      .send({ confirm: "CLOSE PAPER POSITION", action: "paper_long_candidate", pnl: 15 })
      .expect(200);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v2/positions/XLI"), expect.objectContaining({ method: "DELETE" }));
  });

  it("requires a TradingView webhook secret", async () => {
    const app = createApp({
      dataFilePath: "data/test-tv-no-secret.json",
      databaseUrl: undefined,
      tradingViewWebhookSecret: undefined
    });

    const response = await request(app)
      .post("/api/tradingview/webhook")
      .send({ symbol: "SPY", message: "Breakout" })
      .expect(503);

    expect(response.body.error).toMatch(/secret is not configured/);
  });

  it("stores authenticated TradingView signals as review-only events", async () => {
    const app = createApp({
      dataFilePath: "data/test-tv-secret.json",
      databaseUrl: undefined,
      tradingViewWebhookSecret: "test-secret"
    });

    const response = await request(app)
      .post("/api/tradingview/webhook")
      .set("x-tradingview-secret", "test-secret")
      .send({ symbol: "spy", alertName: "Trend alert", timeframe: "1D", message: "Breakout" })
      .expect(200);

    expect(response.body.symbol).toBe("SPY");
    expect(response.body.status).toBe("received");
  });

  it("deletes journal entries from persistent storage", async () => {
    const app = createApp({
      dataFilePath: `data/test-journal-delete-${Date.now()}.json`,
      databaseUrl: undefined
    });

    const created = await request(app)
      .post("/api/journal")
      .send({ symbol: "SPY", status: "watching", action: "watch", notes: "cleanup" })
      .expect(200);

    await request(app).delete(`/api/journal/${created.body.id}`).expect(200);

    const journal = await request(app).get("/api/journal").expect(200);
    expect(journal.body).toEqual([]);
  });

  it("scans opportunities with same-day cache and force refresh", async () => {
    let barRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
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
      if (target.includes("/v2/stocks/")) {
        barRequests += 1;
        if (target.includes("/v2/stocks/SPY/bars")) return jsonResponse({ error: "temporary data gap" }, 500);
        return jsonResponse({ bars: makeBars() });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-opportunities-${Date.now()}.json`
    });

    const first = await request(app).post("/api/opportunities/scan").send({ limit: 3 }).expect(200);
    expect(first.body.cached).toBe(false);
    expect(first.body.scan.candidates.length).toBeGreaterThan(0);
    expect(first.body.scan.skipped[0].symbol).toBe("SPY");
    expect(barRequests).toBe(3);

    const second = await request(app).post("/api/opportunities/scan").send({ limit: 3 }).expect(200);
    expect(second.body.cached).toBe(true);
    expect(barRequests).toBe(3);

    await request(app).post("/api/opportunities/scan").send({ limit: 2, forceRefresh: true }).expect(200);
    expect(barRequests).toBe(5);
  });

  it("returns a SPY and QQQ market regime snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v2/stocks/SPY/bars") || target.includes("/v2/stocks/QQQ/bars")) {
        return jsonResponse({ bars: makeBars() });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-market-regime-${Date.now()}.json`
    });

    const response = await request(app).get("/api/market/regime").expect(200);

    expect(response.body.regime).toBe("bullish");
    expect(response.body.components.map((component: { symbol: string }) => component.symbol)).toEqual(["SPY", "QQQ"]);
    expect(response.body.riskAdjustmentMultiplier).toBe(1);
  });

  it("runs a backtest from historical bars", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
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
      if (target.includes("/v2/stocks/")) return jsonResponse({ bars: makeBars(320) });
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-backtest-${Date.now()}.json`
    });

    const response = await request(app)
      .post("/api/backtest")
      .send({
        symbols: ["AAPL"],
        startDate: "2026-03-01",
        endDate: "2026-05-01",
        holdingPeriodDays: 8,
        maxPositions: 1,
        minScore: 65
      })
      .expect(200);

    expect(response.body.request.symbols).toEqual(["AAPL"]);
    expect(response.body.equityCurve.length).toBeGreaterThan(0);
    expect(response.body.benchmarkReturnPct).not.toBeNull();
  });

  it("reuses cached symbol snapshots to avoid repeated market data calls", async () => {
    let accountRequests = 0;
    let barRequests = 0;
    let snapshotRequests = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v2/account")) {
        accountRequests += 1;
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
        barRequests += 1;
        return jsonResponse({ bars: makeBars() });
      }
      if (target.includes("/v2/stocks/SPY/snapshot")) {
        snapshotRequests += 1;
        return jsonResponse({ ticker: "SPY" });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-symbol-cache-${Date.now()}.json`
    });

    const first = await request(app).get("/api/symbol/SPY").expect(200);
    expect(first.body.cached).toBe(false);

    const second = await request(app).get("/api/symbol/SPY").expect(200);
    expect(second.body.cached).toBe(true);
    expect(accountRequests).toBe(1);
    expect(barRequests).toBe(1);
    expect(snapshotRequests).toBe(1);
  });

  it("reuses cached option ideas to reduce repeated option chain calls", async () => {
    let optionRequests = 0;
    let barRequests = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v2/options/contracts")) {
        optionRequests += 1;
        return jsonResponse({
          option_contracts: [
            {
              symbol: "SPY260515C00600000",
              underlying_symbol: "SPY",
              type: "call",
              expiration_date: "2026-05-15",
              strike_price: "600",
              close_price: "2.5",
              open_interest: "1000"
            }
          ]
        });
      }
      if (target.includes("/v2/stocks/SPY/bars")) {
        barRequests += 1;
        return jsonResponse({ bars: makeBars().slice(-5) });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-options-cache-${Date.now()}.json`
    });

    const first = await request(app).get("/api/options/SPY").expect(200);
    expect(first.body.cached).toBe(false);

    const second = await request(app).get("/api/options/SPY").expect(200);
    expect(second.body.cached).toBe(true);
    expect(optionRequests).toBe(1);
    expect(barRequests).toBe(1);
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

function makeBars(count = 260) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.8;
    return {
      t: new Date(Date.now() - (count - index) * 86400000).toISOString(),
      o: close - 0.5,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1000000 + index * 1000
    };
  });
}
