import cors from "cors";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { AlpacaClient } from "./alpaca";
import { getConfig, isPaperAlpacaUrl, type AppConfig } from "./config";
import { TradeContextService } from "./context";
import { buildSignalSnapshot, getDefaultRiskProfile } from "./indicators";
import { OpenAiTradePlanner } from "./openai";
import { createStore, getStoreDescription } from "./storeFactory";
import type { AppStore } from "./storage";
import { normalizeSymbol, paperOrderSchema, validatePaperOrder, watchlistItemSchema } from "./validation";
import type {
  EnrichedTradePlanResponse,
  HealthStatus,
  JournalStatus,
  PaperOrderRequest,
  SignalSnapshot,
  TradeAction,
  TradeContext,
  WatchlistItem
} from "../src/shared/types";

const CONTEXT_CACHE_MS = 24 * 60 * 60 * 1000;

export function createApp(overrides: Partial<AppConfig> = {}) {
  const config = getConfig(overrides);
  const store = createStore(config);
  const alpaca = new AlpacaClient(config);
  const tradePlanner = new OpenAiTradePlanner(config);
  const tradeContext = new TradeContextService(config);
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    const status: HealthStatus = {
      ok: true,
      alpacaConfigured: alpaca.configured,
      alpacaPaperOnly: isPaperAlpacaUrl(config.alpacaPaperBaseUrl),
      openAiConfigured: tradePlanner.configured,
      openAiModel: config.openAiModel,
      alphaVantageConfigured: Boolean(config.alphaVantageApiKey),
      databaseConfigured: Boolean(config.databaseUrl),
      dataStore: getStoreDescription(config) === "postgres" ? "postgres" : path.resolve(config.dataFilePath)
    };
    response.json(status);
  });

  app.get("/api/watchlist", asyncHandler(async (_request, response) => {
    const data = await store.read();
    response.json(data.watchlist);
  }));

  app.post("/api/watchlist", asyncHandler(async (request, response) => {
    const rawItems = Array.isArray(request.body?.watchlist) ? request.body.watchlist : request.body;
    if (!Array.isArray(rawItems)) {
      response.status(400).json({ error: "Expected an array of watchlist items." });
      return;
    }

    const parsed = rawItems.map((item) => watchlistItemSchema.parse(item));
    const deduped = new Map<string, WatchlistItem>();
    for (const item of parsed) {
      const symbol = normalizeSymbol(item.symbol);
      deduped.set(symbol, {
        symbol,
        notes: item.notes,
        tags: item.tags,
        createdAt: new Date().toISOString()
      });
    }
    const data = await store.setWatchlist([...deduped.values()]);
    response.json(data.watchlist);
  }));

  app.post("/api/scan", asyncHandler(async (request, response) => {
    const symbols = getSymbolsFromRequest(request.body);
    const account = await safeAccount(alpaca);
    const riskProfile = getDefaultRiskProfile(account.equity ?? 100000);
    const snapshots: SignalSnapshot[] = [];

    for (const symbol of symbols) {
      const bars = await alpaca.getBars(symbol);
      snapshots.push(buildSignalSnapshot(symbol, bars, riskProfile));
    }

    const scan = await store.addScanHistory(symbols, snapshots);
    response.json({ scan, snapshots });
  }));

  app.get("/api/symbol/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    const account = await safeAccount(alpaca);
    const riskProfile = getDefaultRiskProfile(account.equity ?? 100000);
    const [bars, snapshot] = await Promise.all([alpaca.getBars(symbol), alpaca.getSnapshot(symbol).catch(() => null)]);
    response.json({
      signal: buildSignalSnapshot(symbol, bars, riskProfile),
      snapshot
    });
  }));

  app.get("/api/options/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    const ideas = await alpaca.getOptionIdeas(symbol);
    response.json({ symbol, ideas });
  }));

  app.get("/api/context/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    response.json(await getContextForSymbol(store, tradeContext, symbol));
  }));

  app.post("/api/ai/trade-plan", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const context = await getContextForSymbol(store, tradeContext, snapshot.symbol);
    const plan = await tradePlanner.createTradePlan(snapshot, context, request.body?.notes);
    const savedPlan = await store.saveTradePlan({
      symbol: snapshot.symbol,
      signalAsOf: snapshot.asOf,
      score: snapshot.score,
      plan,
      context
    });
    const enriched: EnrichedTradePlanResponse = { plan, context, savedPlan };
    response.json(enriched);
  }));

  app.get("/api/trade-plans", asyncHandler(async (_request, response) => {
    response.json(await store.getSavedPlans());
  }));

  app.get("/api/journal", asyncHandler(async (_request, response) => {
    response.json(await store.getJournal());
  }));

  app.post("/api/journal", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(String(request.body?.symbol ?? ""));
    if (!symbol) {
      response.status(400).json({ error: "Symbol is required." });
      return;
    }

    const entry = await store.addJournalEntry({
      symbol,
      planId: request.body?.planId,
      status: normalizeStatus(request.body?.status),
      action: normalizeAction(request.body?.action),
      notes: String(request.body?.notes ?? ""),
      entryPrice: optionalNumber(request.body?.entryPrice),
      exitPrice: optionalNumber(request.body?.exitPrice),
      stopLossPrice: optionalNumber(request.body?.stopLossPrice),
      takeProfitPrice: optionalNumber(request.body?.takeProfitPrice),
      outcome: request.body?.outcome,
      pnl: optionalNumber(request.body?.pnl)
    });
    response.json(entry);
  }));

  app.get("/api/alpaca/account", asyncHandler(async (_request, response) => {
    response.json(await alpaca.getAccount());
  }));

  app.get("/api/alpaca/positions", asyncHandler(async (_request, response) => {
    const [positions, orders] = await Promise.all([alpaca.getPositions(), alpaca.getOrders()]);
    response.json({ positions, orders });
  }));

  app.post("/api/alpaca/paper-orders", asyncHandler(async (request, response) => {
    const parsed = paperOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        ok: false,
        errors: parsed.error.issues.map((issue) => issue.message),
        warnings: [],
        estimatedNotional: null,
        estimatedRisk: null
      });
      return;
    }

    const account = await alpaca.getAccount();
    const riskProfile = getDefaultRiskProfile(account.equity ?? 100000);
    const orderInput = parsed.data as PaperOrderRequest;
    const referencePrice = await getReferencePrice(alpaca, orderInput.symbol);
    const validation = validatePaperOrder(orderInput, riskProfile, referencePrice);

    if (!validation.ok || !validation.order) {
      response.status(400).json(validation);
      return;
    }

    const result = await alpaca.placePaperBracketOrder(validation.order);
    response.json({ validation, order: result });
  }));

  app.use((error: Error, _request: Request, response: Response, _next: unknown) => {
    const status = error.name === "ZodError" ? 400 : error.message.includes("not configured") ? 503 : 500;
    response.status(status).json({ error: error.message });
  });

  return app;
}

function normalizeAction(value: unknown): TradeAction {
  const allowed: TradeAction[] = ["avoid", "watch", "paper_long_candidate", "paper_short_candidate", "options_research_only"];
  return allowed.includes(value as TradeAction) ? (value as TradeAction) : "watch";
}

function normalizeStatus(value: unknown): JournalStatus {
  const allowed: JournalStatus[] = ["watching", "paper_open", "paper_closed", "skipped"];
  return allowed.includes(value as JournalStatus) ? (value as JournalStatus) : "watching";
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asyncHandler(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: (error: unknown) => void) => {
    handler(request, response).catch(next);
  };
}

function getSymbolsFromRequest(body: unknown): string[] {
  const request = body as { symbols?: unknown };
  if (!Array.isArray(request?.symbols)) return [];
  return request.symbols.map((symbol) => normalizeSymbol(String(symbol))).filter(Boolean).slice(0, 25);
}

async function safeAccount(alpaca: AlpacaClient) {
  try {
    return await alpaca.getAccount();
  } catch {
    return {
      equity: 100000
    };
  }
}

async function getReferencePrice(alpaca: AlpacaClient, symbol: string): Promise<number | null> {
  const bars = await alpaca.getBars(symbol, 5);
  return bars.at(-1)?.close ?? null;
}

async function getContextForSymbol(
  store: AppStore,
  tradeContext: TradeContextService,
  symbol: string
): Promise<TradeContext> {
  const cached = await store.getCachedContext(symbol, CONTEXT_CACHE_MS);
  if (cached) {
    return {
      ...cached,
      contextWarnings: [
        ...cached.contextWarnings.filter((warning) => !warning.startsWith("Using cached context")),
        `Using cached context from ${cached.generatedAt} to preserve free API limits.`
      ]
    };
  }

  const context = await tradeContext.build(symbol);
  await store.saveContext(symbol, context);
  return context;
}
