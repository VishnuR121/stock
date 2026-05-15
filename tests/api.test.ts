// @vitest-environment node
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { DEFAULT_SEC_USER_AGENT } from "../server/config";
import type { SignalSnapshot } from "../src/shared/types";

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
    expect(response.body.paperTradingBlockedReasons).toContain("Alpaca live trading URL is blocked.");
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

  it("reports provider and paper safety status without exposing secrets", async () => {
    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      openAiApiKey: "openai-secret",
      alphaVantageApiKey: "alpha-secret",
      secUserAgent: "ResearchCopilot/0.1 test@example.com",
      tradingViewWebhookSecret: "webhook-secret",
      databaseUrl: undefined,
      dataFilePath: "data/test-provider-health.json"
    });

    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.alpacaConfigured).toBe(true);
    expect(response.body.alpacaPaperOnly).toBe(true);
    expect(response.body.paperTradingBlockedReasons).toEqual([]);
    expect(response.body.alphaVantageConfigured).toBe(true);
    expect(response.body.secUserAgentConfigured).toBe(true);
    expect(response.body.tradingViewWebhookConfigured).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("openai-secret");
    expect(JSON.stringify(response.body)).not.toContain("alpha-secret");
    expect(JSON.stringify(response.body)).not.toContain("webhook-secret");
  });

  it("reports the placeholder SEC user agent as unconfigured", async () => {
    const app = createApp({
      secUserAgent: DEFAULT_SEC_USER_AGENT,
      databaseUrl: undefined,
      dataFilePath: `data/test-sec-health-${Date.now()}.json`
    });

    const response = await request(app).get("/api/health").expect(200);
    expect(response.body.secUserAgentConfigured).toBe(false);
  });

  it("skips SEC requests when SEC_USER_AGENT is not configured", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const app = createApp({
      alphaVantageApiKey: undefined,
      secUserAgent: DEFAULT_SEC_USER_AGENT,
      databaseUrl: undefined,
      dataFilePath: `data/test-context-sec-missing-${Date.now()}.json`
    });

    const response = await request(app).get("/api/context/AAPL").expect(200);
    expect(response.body.providers.sec).toBe("missing_user_agent");
    expect(response.body.contextWarnings).toContain("SEC_USER_AGENT is not configured; SEC filings and company facts were not added.");
    expect(fetchSpy).not.toHaveBeenCalled();
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
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.killSwitchEnabled).toBe(true);
    expect(health.body.paperTradingBlockedReasons).toContain("Paper order kill switch is enabled.");

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

  it("creates a linked journal entry after a successful paper order", async () => {
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
      if (target.includes("/v2/stocks/AAPL/bars")) {
        return jsonResponse({
          bars: [
            { t: "2026-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000000 }
          ]
        });
      }
      if (target.includes("/v2/orders")) return jsonResponse({ id: "broker-order-1", symbol: "AAPL" });
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-paper-order-journal-${Date.now()}.json`
    });

    const response = await request(app)
      .post("/api/alpaca/paper-orders")
      .send({
        symbol: "AAPL",
        side: "buy",
        orderType: "market",
        quantity: 2,
        stopLossPrice: 95,
        takeProfitPrice: 110,
        timeInForce: "gtc",
        horizon: "swing",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true,
        sourcePlanId: "plan-aapl-1",
        sourceSignalAsOf: "2026-05-13T14:00:00.000Z",
        followedPlan: true
      })
      .expect(200);

    expect(response.body.journalEntry).toMatchObject({
      symbol: "AAPL",
      status: "paper_open",
      planId: "plan-aapl-1",
      signalAsOf: "2026-05-13T14:00:00.000Z",
      sourceType: "ai_plan",
      sourceId: "plan-aapl-1",
      followedPlan: true,
      outcome: "open"
    });

    const journal = await request(app).get("/api/journal").expect(200);
    expect(journal.body[0].notes).toMatch(/Broker order broker-order-1/);
  });

  it("requires easy-to-borrow Alpaca asset data before short equity paper orders", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
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
      if (target.includes("/v2/assets/TSLA")) {
        return jsonResponse({
          symbol: "TSLA",
          status: "active",
          tradable: true,
          shortable: true,
          easy_to_borrow: false
        });
      }
      if (target.includes("/v2/stocks/TSLA/bars")) {
        return jsonResponse({
          bars: [
            { t: "2026-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000000 }
          ]
        });
      }
      if (target.includes("/v2/orders") && init?.method === "POST") return jsonResponse({ id: "should-not-place" });
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-shortability-block-${Date.now()}.json`
    });

    const response = await request(app)
      .post("/api/alpaca/paper-orders")
      .send({
        symbol: "TSLA",
        side: "sell",
        orderType: "market",
        quantity: 2,
        stopLossPrice: 105,
        takeProfitPrice: 90,
        timeInForce: "gtc",
        horizon: "swing",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      })
      .expect(400);

    expect(response.body.errors.join(" ")).toMatch(/hard-to-borrow/i);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v2/orders"), expect.objectContaining({ method: "POST" }));
  });

  it("places short equity paper orders only after shortability is verified", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
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
      if (target.includes("/v2/assets/SPY")) {
        return jsonResponse({
          symbol: "SPY",
          status: "active",
          tradable: true,
          shortable: true,
          easy_to_borrow: true
        });
      }
      if (target.includes("/v2/stocks/SPY/bars")) {
        return jsonResponse({
          bars: [
            { t: "2026-01-01T00:00:00Z", o: 100, h: 101, l: 99, c: 100, v: 1000000 }
          ]
        });
      }
      if (target.includes("/v2/orders") && init?.method === "POST") return jsonResponse({ id: "short-order-1", symbol: "SPY" });
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-shortability-place-${Date.now()}.json`
    });

    const response = await request(app)
      .post("/api/alpaca/paper-orders")
      .send({
        symbol: "SPY",
        side: "sell",
        orderType: "market",
        quantity: 2,
        stopLossPrice: 105,
        takeProfitPrice: 90,
        timeInForce: "gtc",
        horizon: "swing",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      })
      .expect(200);

    expect(response.body.journalEntry).toMatchObject({
      symbol: "SPY",
      action: "paper_short_candidate",
      expressionType: "short_equity"
    });
  });

  it("creates an internal options paper simulation without broker order submission", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
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
      if (target.includes("/v2/positions")) return jsonResponse([]);
      if (target.includes("/v2/orders")) return jsonResponse([]);
      if (target.includes("/v2/options/contracts")) {
        return jsonResponse({
          option_contracts: [{
            symbol: "AAPL260619C00145000",
            underlying_symbol: "AAPL",
            type: "call",
            expiration_date: "2026-06-19",
            strike_price: "145",
            close_price: "4.5",
            bid_price: "4.4",
            ask_price: "4.6",
            open_interest: "250",
            volume: "100"
          }]
        });
      }
      if (target.includes("/v2/stocks/AAPL/bars")) {
        return jsonResponse({ bars: [{ t: "2026-05-14T00:00:00Z", o: 140, h: 142, l: 139, c: 140, v: 1000 }] });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-options-paper-${Date.now()}.json`
    });

    const response = await request(app)
      .post("/api/paper/multi-leg-orders")
      .send({
        expressionType: "long_call",
        underlyingSymbol: "AAPL",
        legs: [{
          optionSymbol: "AAPL260619C00145000",
          underlyingSymbol: "AAPL",
          optionType: "call",
          side: "buy",
          quantity: 1,
          strike: 145,
          expiration: "2026-06-19",
          estimatedMid: 4.5,
          bid: 4.4,
          ask: 4.6,
          openInterest: 250,
          volume: 100
        }],
        estimatedDebit: 450,
        maxLoss: 450,
        breakeven: 149.5,
        requiredCapital: 450,
        paperExecutionMode: "internal_simulation",
        timeHorizon: "30-60 DTE swing options",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true,
        maxLossAcknowledged: true,
        paperSimulationAcknowledged: true,
        noLiveEndpointAcknowledged: true
      })
      .expect(200);

    expect(response.body.order.status).toBe("internally_simulated_paper");
    expect(response.body.journalEntry).toMatchObject({
      symbol: "AAPL",
      status: "paper_open",
      action: "paper_options_candidate",
      expressionType: "long_call",
      paperExecutionMode: "internal_simulation"
    });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v2/orders"), expect.objectContaining({ method: "POST" }));
  });

  it("monitors and closes an internal options paper simulation without broker execution", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v2/account")) {
        return jsonResponse({
          equity: "100000",
          buying_power: "50000",
          cash: "50000",
          paper: true
        });
      }
      if (target.includes("/v2/positions")) return jsonResponse([]);
      if (target.includes("/v2/orders")) return jsonResponse([]);
      if (target.includes("/v2/options/contracts")) {
        return jsonResponse({
          option_contracts: [{
            symbol: "AAPL260619C00145000",
            underlying_symbol: "AAPL",
            type: "call",
            expiration_date: "2026-06-19",
            strike_price: "145",
            close_price: "6",
            bid_price: "5.9",
            ask_price: "6.1",
            open_interest: "250",
            volume: "100"
          }]
        });
      }
      if (target.includes("/v2/stocks/AAPL/bars")) {
        return jsonResponse({ bars: [{ t: "2026-05-14T00:00:00Z", o: 140, h: 142, l: 139, c: 140, v: 1000 }] });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-options-sim-close-${Date.now()}.json`
    });

    const opened = await request(app)
      .post("/api/paper/multi-leg-orders")
      .send({
        expressionType: "long_call",
        underlyingSymbol: "AAPL",
        legs: [{
          optionSymbol: "AAPL260619C00145000",
          underlyingSymbol: "AAPL",
          optionType: "call",
          side: "buy",
          quantity: 1,
          strike: 145,
          expiration: "2026-06-19",
          estimatedMid: 4.5,
          bid: 4.4,
          ask: 4.6,
          openInterest: 250,
          volume: 100
        }],
        estimatedDebit: 450,
        maxLoss: 450,
        breakeven: 149.5,
        requiredCapital: 450,
        paperExecutionMode: "internal_simulation",
        timeHorizon: "30-60 DTE swing options",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true,
        maxLossAcknowledged: true,
        paperSimulationAcknowledged: true,
        noLiveEndpointAcknowledged: true
      })
      .expect(200);

    const snapshot = await request(app).get("/api/paper/options-simulations").expect(200);
    expect(snapshot.body.positions[0]).toMatchObject({
      id: opened.body.order.id,
      underlyingSymbol: "AAPL",
      currentValue: 600,
      unrealizedPnL: 150
    });

    const closed = await request(app)
      .post(`/api/paper/options-simulations/${opened.body.order.id}/close`)
      .send({
        confirm: "CLOSE OPTIONS SIMULATION",
        exitReason: "target"
      })
      .expect(200);

    expect(closed.body.result).toMatchObject({
      status: "internally_simulated_paper_closed",
      brokerSubmitted: false
    });
    expect(closed.body.journalEntry).toMatchObject({
      status: "paper_closed",
      exitReason: "target",
      realizedPnL: 150,
      actualRMultiple: 0.33
    });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v2/positions/AAPL"), expect.objectContaining({ method: "DELETE" }));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v2/orders"), expect.objectContaining({ method: "POST" }));
  });

  it("blocks a new options simulation when open simulated contracts exceed the risk cap", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v2/account")) {
        return jsonResponse({
          equity: "100000",
          buying_power: "100000",
          cash: "100000",
          paper: true
        });
      }
      if (target.includes("/v2/positions")) return jsonResponse([]);
      if (target.includes("/v2/orders")) return jsonResponse([]);
      if (target.includes("/v2/options/contracts")) {
        return jsonResponse({
          option_contracts: [{
            symbol: "AAPL260619C00145000",
            underlying_symbol: "AAPL",
            type: "call",
            expiration_date: "2026-06-19",
            strike_price: "145",
            close_price: "4.5",
            bid_price: "4.4",
            ask_price: "4.6",
            open_interest: "250",
            volume: "100"
          }]
        });
      }
      if (target.includes("/v2/stocks/AAPL/bars")) {
        return jsonResponse({ bars: [{ t: "2026-05-14T00:00:00Z", o: 140, h: 142, l: 139, c: 140, v: 1000 }] });
      }
      return jsonResponse({});
    });

    const app = createApp({
      alpacaKeyId: "key",
      alpacaSecretKey: "secret",
      databaseUrl: undefined,
      dataFilePath: `data/test-options-open-cap-${Date.now()}.json`
    });

    await request(app)
      .post("/api/journal")
      .send({
        symbol: "AAPL",
        status: "paper_open",
        action: "paper_options_candidate",
        notes: "Existing options simulation.",
        expressionType: "long_call",
        underlyingSymbol: "AAPL",
        assetClass: "option",
        paperExecutionMode: "internal_simulation",
        requiredCapital: 1800,
        optionLegs: [{
          optionSymbol: "AAPL260619C00145000",
          underlyingSymbol: "AAPL",
          optionType: "call",
          side: "buy",
          quantity: 4,
          strike: 145,
          expiration: "2026-06-19",
          estimatedMid: 4.5,
          openInterest: 250,
          volume: 100
        }]
      })
      .expect(200);

    const response = await request(app)
      .post("/api/paper/multi-leg-orders")
      .send({
        expressionType: "long_call",
        underlyingSymbol: "AAPL",
        legs: [{
          optionSymbol: "AAPL260619C00145000",
          underlyingSymbol: "AAPL",
          optionType: "call",
          side: "buy",
          quantity: 1,
          strike: 145,
          expiration: "2026-06-19",
          estimatedMid: 4.5,
          bid: 4.4,
          ask: 4.6,
          openInterest: 250,
          volume: 100
        }],
        estimatedDebit: 450,
        maxLoss: 450,
        breakeven: 149.5,
        requiredCapital: 450,
        paperExecutionMode: "internal_simulation",
        timeHorizon: "30-60 DTE swing options",
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true,
        maxLossAcknowledged: true,
        paperSimulationAcknowledged: true,
        noLiveEndpointAcknowledged: true
      })
      .expect(400);

    expect(response.body.errors.join(" ")).toMatch(/Open options simulations plus this order exceed max options contract limit/i);
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

    const opened = await request(app)
      .post("/api/journal")
      .send({
        symbol: "XLI",
        status: "paper_open",
        action: "paper_long_candidate",
        notes: "Opened from paper order.",
        entryPrice: 100,
        stopLossPrice: 95,
        takeProfitPrice: 115,
        outcome: "open",
        followedPlan: true
      })
      .expect(200);

    const closed = await request(app)
      .post("/api/alpaca/paper-positions/XLI/close")
      .send({
        confirm: "CLOSE PAPER POSITION",
        action: "paper_long_candidate",
        exitReason: "target",
        exitPrice: 115,
        pnl: 15,
        notes: "Closed at target."
      })
      .expect(200);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v2/positions/XLI"), expect.objectContaining({ method: "DELETE" }));
    expect(closed.body.journalEntry).toMatchObject({
      id: opened.body.id,
      status: "paper_closed",
      exitReason: "target",
      entryPrice: 100,
      stopLossPrice: 95,
      exitPrice: 115,
      pnl: 15,
      outcome: "win"
    });

    const journal = await request(app).get("/api/journal").expect(200);
    expect(journal.body).toHaveLength(1);
    expect(journal.body[0].status).toBe("paper_closed");

    const analytics = await request(app).get("/api/journal/analytics").expect(200);
    expect(analytics.body.openPaperTrades).toBe(0);
    expect(analytics.body.closedPaperTrades).toBe(1);
    expect(analytics.body.mostCommonExitReason).toBe("target");
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

  it("updates journal review fields without creating a new entry", async () => {
    const app = createApp({
      dataFilePath: `data/test-journal-update-${Date.now()}.json`,
      databaseUrl: undefined
    });

    const created = await request(app)
      .post("/api/journal")
      .send({
        symbol: "SPY",
        status: "paper_open",
        action: "paper_long_candidate",
        notes: "Opened from plan.",
        followedPlan: true,
        outcome: "open"
      })
      .expect(200);

    const updated = await request(app)
      .patch(`/api/journal/${created.body.id}`)
      .send({
        status: "paper_closed",
        notes: "Closed after review.",
        followedPlan: false,
        exitReason: "score_drop",
        outcome: "loss",
        pnl: -42.5
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      id: created.body.id,
      status: "paper_closed",
      notes: "Closed after review.",
      followedPlan: false,
      exitReason: "score_drop",
      outcome: "loss",
      pnl: -42.5
    });

    const journal = await request(app).get("/api/journal").expect(200);
    expect(journal.body).toHaveLength(1);
    expect(journal.body[0].id).toBe(created.body.id);
  });

  it("returns journal analytics from stored journal entries", async () => {
    const app = createApp({
      dataFilePath: `data/test-journal-analytics-${Date.now()}.json`,
      databaseUrl: undefined
    });

    await request(app)
      .post("/api/journal")
      .send({
        symbol: "AAPL",
        status: "paper_closed",
        action: "paper_long_candidate",
        notes: "followed plan",
        entryPrice: 100,
        stopLossPrice: 95,
        pnl: 250,
        outcome: "win"
      })
      .expect(200);

    const response = await request(app).get("/api/journal/analytics").expect(200);
    expect(response.body.totalPaperTrades).toBe(1);
    expect(response.body.winRate).toBe(100);
    expect(response.body.bestTrade.symbol).toBe("AAPL");
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

  it("builds a deterministic trade plan without requiring AI", async () => {
    const app = createApp({
      alpacaKeyId: undefined,
      alpacaSecretKey: undefined,
      databaseUrl: undefined,
      dataFilePath: `data/test-quant-plan-${Date.now()}.json`
    });

    const response = await request(app)
      .post("/api/trade-plan/deterministic")
      .send({ snapshot: makeSignalSnapshot() })
      .expect(200);

    expect(response.body.symbol).toBe("AAPL");
    expect(response.body.action).toBe("paper_long_candidate");
    expect(response.body.ranking.action).toBe("buy");
    expect(response.body.marketRegime).toBeNull();
    expect(response.body.keyRisks.join(" ")).toMatch(/paper-trading research/i);
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

function makeSignalSnapshot(): SignalSnapshot {
  return {
    symbol: "AAPL",
    asOf: "2026-05-13T14:00:00.000Z",
    lastPrice: 150,
    previousClose: 148,
    sma20: 142,
    sma50: 135,
    sma200: 120,
    rsi14: 58,
    atr14: 4,
    volumeRatio: 1.25,
    recentHigh: 152,
    recentLow: 140,
    suggestedStop: 140,
    suggestedTarget: 174,
    riskReward: 2.4,
    trend: "uptrend",
    bias: "bullish",
    score: 84,
    positionSizeShares: 100,
    positionNotional: 15000,
    riskDollars: 1000,
    notes: [],
    bars: makeBars().map((bar) => ({
      timestamp: bar.t,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v
    }))
  };
}
