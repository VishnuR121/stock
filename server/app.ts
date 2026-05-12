import cors from "cors";
import express, { type Request, type Response } from "express";
import path from "node:path";
import { AlpacaClient } from "./alpaca";
import { buildAnalysisRun, buildFallbackManagerVerdict, buildSafetyBlockers, buildSpecialistReports } from "./analysis";
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
  AnalysisMode,
  RiskSettings,
  SignalSnapshot,
  TradeAction,
  TradeContext,
  TradingViewSignal,
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
    response.json(await store.getWatchlist());
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

  app.post("/api/ai/analysis-run", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const mode: AnalysisMode = request.body?.mode === "deep" ? "deep" : "fast";
    const symbol = normalizeSymbol(snapshot.symbol);
    const [context, options, account, positionsResponse, journal, riskSettings, marketSnapshots] = await Promise.all([
      getContextForSymbol(store, tradeContext, symbol),
      alpaca.getOptionIdeas(symbol).catch(() => []),
      safeAccount(alpaca),
      safePositions(alpaca),
      store.getJournal(),
      store.getRiskSettings(),
      getMarketSnapshots(alpaca, store)
    ]);

    const analysisInput = {
      mode,
      snapshot: { ...snapshot, symbol },
      context,
      options,
      account,
      positions: positionsResponse.positions,
      journal,
      riskSettings,
      marketSnapshots
    };
    const specialistReports = buildSpecialistReports(analysisInput);
    const safetyBlockers = buildSafetyBlockers(analysisInput);
    let managerVerdict = buildFallbackManagerVerdict(analysisInput.snapshot, specialistReports, safetyBlockers);

    if (tradePlanner.configured) {
      managerVerdict = await tradePlanner.createManagerVerdict({
        snapshot: analysisInput.snapshot,
        context,
        specialistReports,
        safetyBlockers,
        userNotes: request.body?.notes
      });
      managerVerdict = enforceSafetyOnVerdict(managerVerdict, safetyBlockers);
    }

    const analysisRun = buildAnalysisRun({ ...analysisInput, managerVerdict });
    await store.saveAnalysisRun(analysisRun);
    response.json({ analysisRun });
  }));

  app.get("/api/analysis-runs/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    response.json(await store.getAnalysisRuns(symbol));
  }));

  app.get("/api/trade-plans", asyncHandler(async (_request, response) => {
    response.json(await store.getSavedPlans());
  }));

  app.get("/api/journal", asyncHandler(async (_request, response) => {
    response.json(await store.getJournal());
  }));

  app.get("/api/settings/risk", asyncHandler(async (_request, response) => {
    response.json(await store.getRiskSettings());
  }));

  app.post("/api/settings/risk", asyncHandler(async (request, response) => {
    const current = await store.getRiskSettings();
    const next: RiskSettings = {
      ...current,
      ...request.body,
      maxRiskPerTradePct: optionalNumber(request.body?.maxRiskPerTradePct) ?? current.maxRiskPerTradePct,
      maxPositionPct: optionalNumber(request.body?.maxPositionPct) ?? current.maxPositionPct,
      maxDailyLossPct: optionalNumber(request.body?.maxDailyLossPct) ?? current.maxDailyLossPct,
      minRiskReward: optionalNumber(request.body?.minRiskReward) ?? current.minRiskReward,
      maxDataAgeMinutes: optionalNumber(request.body?.maxDataAgeMinutes) ?? current.maxDataAgeMinutes,
      priceCollarPct: optionalNumber(request.body?.priceCollarPct) ?? current.priceCollarPct,
      earningsWindowDays: optionalNumber(request.body?.earningsWindowDays) ?? current.earningsWindowDays,
      killSwitchEnabled: typeof request.body?.killSwitchEnabled === "boolean"
        ? request.body.killSwitchEnabled
        : current.killSwitchEnabled
    };
    response.json(await store.saveRiskSettings(next));
  }));

  app.get("/api/tradingview/signals", asyncHandler(async (_request, response) => {
    response.json(await store.getTradingViewSignals());
  }));

  app.post("/api/tradingview/webhook", asyncHandler(async (request, response) => {
    if (!config.tradingViewWebhookSecret) {
      response.status(503).json({ error: "TradingView webhook secret is not configured." });
      return;
    }

    const providedSecret = request.header("x-tradingview-secret") || request.body?.secret;
    if (providedSecret !== config.tradingViewWebhookSecret) {
      response.status(401).json({ error: "Invalid TradingView webhook secret." });
      return;
    }

    const symbol = normalizeSymbol(String(request.body?.symbol ?? request.body?.ticker ?? ""));
    if (!symbol) {
      response.status(400).json({ error: "TradingView alert payload must include symbol or ticker." });
      return;
    }

    const signal: TradingViewSignal = {
      id: `tv-${symbol}-${Date.now()}`,
      createdAt: new Date().toISOString(),
      symbol,
      alertName: optionalString(request.body?.alertName ?? request.body?.alert_name),
      timeframe: optionalString(request.body?.timeframe ?? request.body?.interval),
      message: String(request.body?.message ?? "TradingView alert received."),
      payload: request.body ?? {},
      status: "received"
    };
    response.json(await store.saveTradingViewSignal(signal));
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
    const riskSettings = await store.getRiskSettings();
    if (riskSettings.killSwitchEnabled) {
      response.status(423).json({
        ok: false,
        errors: ["Paper order entry is disabled because the kill switch is enabled."],
        warnings: [],
        estimatedNotional: null,
        estimatedRisk: null
      });
      return;
    }
    const riskProfile = getRiskProfile(account.equity ?? 100000, riskSettings);
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

  app.post("/api/alpaca/paper-orders/cancel-open", asyncHandler(async (_request, response) => {
    response.json({ result: await alpaca.cancelOpenOrders() });
  }));

  app.post("/api/alpaca/paper-positions/flatten", asyncHandler(async (request, response) => {
    if (request.body?.confirm !== "FLATTEN PAPER POSITIONS") {
      response.status(400).json({ error: "Type FLATTEN PAPER POSITIONS to confirm this paper-only emergency action." });
      return;
    }
    response.json({ result: await alpaca.closeAllPositions() });
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

async function safePositions(alpaca: AlpacaClient): Promise<{ positions: unknown[]; orders: unknown[] }> {
  try {
    const [positions, orders] = await Promise.all([alpaca.getPositions(), alpaca.getOrders()]);
    return { positions, orders };
  } catch {
    return { positions: [], orders: [] };
  }
}

async function getMarketSnapshots(alpaca: AlpacaClient, store: AppStore): Promise<SignalSnapshot[]> {
  const account = await safeAccount(alpaca);
  const riskSettings = await store.getRiskSettings();
  const riskProfile = getRiskProfile(account.equity ?? 100000, riskSettings);
  const symbols = ["SPY", "QQQ"];
  const snapshots: SignalSnapshot[] = [];
  for (const symbol of symbols) {
    try {
      snapshots.push(buildSignalSnapshot(symbol, await alpaca.getBars(symbol), riskProfile));
    } catch {
      // Market regime is useful, not required for the analysis run.
    }
  }
  return snapshots;
}

function getRiskProfile(accountEquity: number, settings: RiskSettings) {
  return {
    ...getDefaultRiskProfile(accountEquity),
    maxRiskPerTradePct: settings.maxRiskPerTradePct,
    maxPositionPct: settings.maxPositionPct,
    maxDailyLossPct: settings.maxDailyLossPct,
    minRiskReward: settings.minRiskReward
  };
}

function enforceSafetyOnVerdict<T extends { action: TradeAction; warnings: string[] }>(verdict: T, blockers: Array<{ severity: string; message: string }>): T {
  if (!blockers.some((blocker) => blocker.severity === "blocker")) return verdict;
  return {
    ...verdict,
    action: verdict.action === "avoid" ? "avoid" : "watch",
    warnings: [...new Set([...verdict.warnings, ...blockers.map((blocker) => blocker.message)])]
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
