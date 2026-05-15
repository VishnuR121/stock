import cors from "cors";
import express, { type Request, type Response } from "express";
import { AlpacaClient } from "./alpaca";
import { buildAlgoTradeProposals } from "./algo";
import { buildAnalysisRun, buildFallbackManagerVerdict, buildSafetyBlockers, buildSpecialistReports } from "./analysis";
import { runBacktest } from "./backtest";
import { buildJournalAnalytics } from "./journalAnalytics";
import { createTradePlanner } from "./ai";
import { getConfig, isConfiguredSecUserAgent, isPaperAlpacaUrl, type AppConfig } from "./config";
import { TradeContextService } from "./context";
import { buildSignalSnapshot, getDefaultRiskProfile } from "./indicators";
import { buildMarketRegimeSnapshot } from "./marketRegime";
import { buildOpportunityScan, dateKey } from "./opportunities";
import { enrichOptionIdeas } from "./options";
import { buildSimulatedOptionsSnapshot } from "./optionsSimulation";
import { buildPositionMonitorSnapshot } from "./positionMonitor";
import { createStore, getStoreDescription } from "./storeFactory";
import { buildDeterministicTradePlan, constrainAiTradePlanToQuantPlan } from "./tradePlan";
import { buildTradeExpressionResult } from "./tradeExpression";
import type { AppStore } from "./storage";
import { multiLegPaperOrderSchema, normalizeSymbol, paperOrderSchema, validateMultiLegPaperOrder, validatePaperOrder, watchlistItemSchema } from "./validation";
import type {
  EnrichedTradePlanResponse,
  AlgoTradeProposal,
  AssetClass,
  BacktestRequest,
  HealthStatus,
  JournalExitReason,
  JournalSourceType,
  JournalStatus,
  MarketRegimeLabel,
  MultiLegPaperOrderRequest,
  PaperOrderRequest,
  PaperExecutionMode,
  PaperOrderValidationResult,
  AnalysisMode,
  RiskSettings,
  SignalSnapshot,
  TradeAction,
  TradeContext,
  TradeExpressionType,
  TradeExpressionPreference,
  TradeJournalEntry,
  TradingViewSignal,
  WatchlistItem
} from "../src/shared/types";

const CONTEXT_CACHE_MS = 24 * 60 * 60 * 1000;
const SIGNAL_CACHE_MS = 15 * 60 * 1000;
const OPTIONS_CACHE_MS = 15 * 60 * 1000;

export function createApp(overrides: Partial<AppConfig> = {}) {
  const config = getConfig(overrides);
  const store = createStore(config);
  const alpaca = new AlpacaClient(config);
  const tradePlanner = createTradePlanner(config);
  const tradeContext = new TradeContextService(config);
  const app = express();

  const createAnalysisFromSnapshot = async (rawSnapshot: SignalSnapshot, mode: AnalysisMode, notes?: unknown) => {
    const symbol = normalizeSymbol(rawSnapshot.symbol);
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
      snapshot: { ...rawSnapshot, symbol },
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
        userNotes: optionalString(notes)
      });
      managerVerdict = enforceSafetyOnVerdict(managerVerdict, safetyBlockers);
    }

    const analysisRun = buildAnalysisRun({ ...analysisInput, managerVerdict });
    await Promise.all([
      store.saveAnalysisRun(analysisRun),
      store.saveSignalSnapshot(analysisInput.snapshot)
    ]);
    return { analysisRun, account, riskSettings };
  };

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", asyncHandler(async (_request, response) => {
    const riskSettings = await store.getRiskSettings();
    const alpacaPaperOnly = isPaperAlpacaUrl(config.alpacaPaperBaseUrl);
    const paperTradingBlockedReasons = getPaperTradingBlockedReasons({
      alpacaConfigured: alpaca.configured,
      alpacaPaperOnly,
      killSwitchEnabled: riskSettings.killSwitchEnabled
    });
    const status: HealthStatus = {
      ok: true,
      alpacaConfigured: alpaca.configured,
      alpacaPaperOnly,
      paperTradingBlockedReasons,
      killSwitchEnabled: riskSettings.killSwitchEnabled,
      aiProvider: config.aiProvider,
      aiConfigured: tradePlanner.configured,
      aiModel: config.aiProvider === "anthropic" ? config.anthropicModel : config.openAiModel,
      openAiConfigured: Boolean(config.openAiApiKey),
      openAiModel: config.openAiModel,
      anthropicConfigured: Boolean(config.anthropicApiKey),
      anthropicModel: config.anthropicModel,
      alphaVantageConfigured: Boolean(config.alphaVantageApiKey),
      secUserAgentConfigured: isConfiguredSecUserAgent(config.secUserAgent),
      tradingViewWebhookConfigured: Boolean(config.tradingViewWebhookSecret),
      databaseConfigured: Boolean(config.databaseUrl),
      dataStore: getStoreDescription(config)
    };
    response.json(status);
  }));

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
    await Promise.all(snapshots.map((snapshot) => store.saveSignalSnapshot(snapshot)));
    response.json({ scan, snapshots });
  }));

  app.post("/api/opportunities/scan", asyncHandler(async (request, response) => {
    const forceRefresh = request.body?.forceRefresh === true;
    const today = dateKey();
    const cached = await store.getLatestOpportunityScan();
    if (!forceRefresh && cached?.dateKey === today) {
      response.json({ scan: cached, cached: true });
      return;
    }

    const [account, riskSettings] = await Promise.all([safeAccount(alpaca), store.getRiskSettings()]);
    const riskProfile = getRiskProfile(account.equity ?? 100000, riskSettings);
    const limit = optionalNumber(request.body?.limit);
    const scan = await buildOpportunityScan({
      riskProfile,
      riskSettings,
      limit,
      getBars: (symbol) => alpaca.getBars(symbol)
    });
    response.json({ scan: await store.saveOpportunityScan(scan), cached: false });
  }));

  app.get("/api/market/regime", asyncHandler(async (_request, response) => {
    const [spyBars, qqqBars] = await Promise.all([
      alpaca.getBars("SPY"),
      alpaca.getBars("QQQ")
    ]);
    response.json(buildMarketRegimeSnapshot({ spyBars, qqqBars }));
  }));

  app.post("/api/backtest", asyncHandler(async (request, response) => {
    const backtestRequest = normalizeBacktestRequestBody(request.body);
    if (!backtestRequest) {
      response.status(400).json({ error: "Backtest requires symbols, startDate, and endDate." });
      return;
    }

    const [account, riskSettings] = await Promise.all([safeAccount(alpaca), store.getRiskSettings()]);
    const fetchOptions = getBacktestBarsOptions(backtestRequest);
    const uniqueSymbols = [...new Set([...backtestRequest.symbols, "SPY", "QQQ"])];
    const entries = await Promise.all(
      uniqueSymbols.map(async (symbol) => [symbol, await alpaca.getBars(symbol, fetchOptions)] as const)
    );
    const barsBySymbol = Object.fromEntries(entries);
    response.json(runBacktest({
      request: {
        ...backtestRequest,
        initialEquity: backtestRequest.initialEquity ?? account.equity ?? 100000
      },
      barsBySymbol,
      benchmarkBars: barsBySymbol.SPY ?? [],
      qqqBars: barsBySymbol.QQQ ?? [],
      riskSettings
    }));
  }));

  app.get("/api/symbol/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    const cachedSignal = await store.getCachedSignal(symbol, SIGNAL_CACHE_MS);
    if (cachedSignal) {
      response.json({
        signal: cachedSignal,
        snapshot: null,
        cached: true
      });
      return;
    }

    const account = await safeAccount(alpaca);
    const riskProfile = getDefaultRiskProfile(account.equity ?? 100000);
    const [bars, snapshot] = await Promise.all([alpaca.getBars(symbol), alpaca.getSnapshot(symbol).catch(() => null)]);
    const signal = await store.saveSignalSnapshot(buildSignalSnapshot(symbol, bars, riskProfile));
    response.json({
      signal,
      snapshot,
      cached: false
    });
  }));

  app.get("/api/options/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    const cachedIdeas = await store.getCachedOptionIdeas(symbol, OPTIONS_CACHE_MS);
    if (cachedIdeas) {
      response.json({ symbol, ideas: cachedIdeas, cached: true });
      return;
    }

    const [ideas, bars] = await Promise.all([
      alpaca.getOptionIdeas(symbol),
      alpaca.getBars(symbol, 5).catch(() => [])
    ]);
    const enriched = enrichOptionIdeas(ideas, bars.at(-1)?.close ?? null);
    await store.saveOptionIdeas(symbol, enriched);
    response.json({ symbol, ideas: enriched, cached: false });
  }));

  app.post("/api/trade-expressions", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const symbol = normalizeSymbol(snapshot.symbol);
    const preference = normalizeTradeExpressionPreference(request.body?.preference);
    const requestOptions = Array.isArray(request.body?.options) ? request.body.options : undefined;
    const [riskSettings, account, positionsResponse, marketRegime, context, options] = await Promise.all([
      store.getRiskSettings(),
      safeAccount(alpaca),
      safePositions(alpaca),
      getMarketRegimeSnapshot(alpaca).catch(() => null),
      getContextForSymbol(store, tradeContext, symbol).catch(() => undefined),
      requestOptions ? Promise.resolve(requestOptions) : getOptionsForExpression(store, alpaca, symbol)
    ]);

    response.json(buildTradeExpressionResult({
      snapshot: { ...snapshot, symbol },
      marketRegime,
      currentHoldings: positionsResponse.positions,
      riskSettings,
      account,
      options,
      earningsDate: context?.earnings?.nextEarningsDate,
      preference
    }));
  }));

  app.get("/api/context/:symbol", asyncHandler(async (request, response) => {
    const symbol = normalizeSymbol(request.params.symbol);
    response.json(await getContextForSymbol(store, tradeContext, symbol));
  }));

  app.post("/api/trade-plan/deterministic", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const [riskSettings, marketRegime] = await Promise.all([
      store.getRiskSettings(),
      getMarketRegimeSnapshot(alpaca).catch(() => null)
    ]);
    response.json(buildDeterministicTradePlan({ snapshot, riskSettings, marketRegime }));
  }));

  app.post("/api/ai/trade-plan", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const [context, riskSettings, marketRegime, account, positionsResponse, options] = await Promise.all([
      getContextForSymbol(store, tradeContext, snapshot.symbol),
      store.getRiskSettings(),
      getMarketRegimeSnapshot(alpaca).catch(() => null),
      safeAccount(alpaca),
      safePositions(alpaca),
      getOptionsForExpression(store, alpaca, snapshot.symbol)
    ]);
    const quantitativePlan = buildDeterministicTradePlan({ snapshot, riskSettings, marketRegime });
    const tradeExpressionResult = buildTradeExpressionResult({
      snapshot,
      marketRegime,
      currentHoldings: positionsResponse.positions,
      riskSettings,
      account,
      options,
      earningsDate: context.earnings?.nextEarningsDate
    });
    const aiPlan = await tradePlanner.createTradePlan(snapshot, context, request.body?.notes, quantitativePlan, tradeExpressionResult);
    const plan = constrainAiTradePlanToQuantPlan(aiPlan, quantitativePlan);
    const savedPlan = await store.saveTradePlan({
      symbol: snapshot.symbol,
      signalAsOf: snapshot.asOf,
      score: snapshot.score,
      plan,
      context
    });
    const enriched: EnrichedTradePlanResponse = { plan, context, savedPlan, quantitativePlan, tradeExpressionResult };
    response.json(enriched);
  }));

  app.post("/api/ai/analysis-run", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const mode: AnalysisMode = request.body?.mode === "deep" ? "deep" : "fast";
    const { analysisRun } = await createAnalysisFromSnapshot(snapshot, mode, request.body?.notes);
    response.json({ analysisRun });
  }));

  app.get("/api/algo/proposals", asyncHandler(async (_request, response) => {
    response.json(await store.getAlgoTradeProposals());
  }));

  app.post("/api/algo/proposals", asyncHandler(async (request, response) => {
    const snapshot = request.body?.snapshot as SignalSnapshot | undefined;
    if (!snapshot?.symbol || !Array.isArray(snapshot.bars)) {
      response.status(400).json({ error: "A SignalSnapshot with recent bars is required." });
      return;
    }

    const mode: AnalysisMode = request.body?.mode === "deep" ? "deep" : "fast";
    const { analysisRun, account, riskSettings } = await createAnalysisFromSnapshot(snapshot, mode, request.body?.notes);
    const proposals = buildAlgoTradeProposals({
      analysisRun,
      account,
      riskSettings,
      referencePrice: analysisRun.snapshot.lastPrice
    });
    response.json({ analysisRun, proposals: await store.saveAlgoTradeProposals(proposals) });
  }));

  app.post("/api/algo/proposals/:id/reject", asyncHandler(async (request, response) => {
    const proposal = await store.updateAlgoTradeProposal(request.params.id, {
      status: "rejected",
      reviewedAt: new Date().toISOString(),
      rejectionReason: optionalString(request.body?.reason) ?? "Rejected after review."
    });
    response.json({ proposal });
  }));

  app.delete("/api/algo/proposals/:id", asyncHandler(async (request, response) => {
    response.json(await store.deleteAlgoTradeProposal(request.params.id));
  }));

  app.post("/api/algo/proposals/:id/execute", asyncHandler(async (request, response) => {
    const proposal = await getAlgoProposal(store, request.params.id);
    if (!proposal.executable || proposal.executionType === "research_only") {
      response.status(400).json({ error: "This proposal is research-only or missing an executable paper order." });
      return;
    }
    if (proposal.status !== "queued") {
      response.status(400).json({ error: `This proposal is already ${proposal.status}.` });
      return;
    }
    if (!request.body?.earningsChecked || !request.body?.confirmedPaperOnly || !request.body?.acceptedRisk) {
      response.status(400).json({ error: "Confirm earnings/event timing, paper-only execution, and accepted risk before placing." });
      return;
    }

    const riskSettings = await store.getRiskSettings();
    if (riskSettings.killSwitchEnabled) {
      response.status(423).json({ error: "Paper order entry is disabled because the kill switch is enabled." });
      return;
    }
    const account = await alpaca.getAccount();
    const riskProfile = getRiskProfile(account.equity ?? 100000, riskSettings);
    let brokerOrder: unknown;
    let validation: (PaperOrderValidationResult & { order?: PaperOrderRequest }) | undefined = proposal.validation;
    let journalAction: TradeAction = "watch";
    let entryPrice: number | undefined;

    if ((proposal.executionType === "long_stock_bracket" || proposal.executionType === "short_stock_bracket") && proposal.order) {
      const order: PaperOrderRequest = {
        ...proposal.order,
        earningsChecked: true,
        confirmedPaperOnly: true,
        acceptedRisk: true
      };
      const referencePrice = await getReferencePrice(alpaca, order.symbol);
      validation = validatePaperOrder(order, riskProfile, referencePrice);
      if (!validation.ok || !validation.order) {
        const updated = await store.updateAlgoTradeProposal(proposal.id, {
          status: "blocked",
          validation,
          targetRealism: validation.targetRealism,
          warnings: [...new Set([...proposal.warnings, ...validation.errors])]
        });
        response.status(400).json({ proposal: updated, validation });
        return;
      }
      brokerOrder = await alpaca.placePaperBracketOrder(validation.order);
      journalAction = order.side === "sell" ? "paper_short_candidate" : "paper_long_candidate";
      entryPrice = referencePrice ?? undefined;
    } else if (proposal.executionType === "long_option" && proposal.optionOrder) {
      const updated = await store.updateAlgoTradeProposal(proposal.id, {
        status: "blocked",
        warnings: [...new Set([...proposal.warnings, "Options are analysis-only; paper option order placement is disabled."])]
      });
      response.status(400).json({ proposal: updated });
      return;
    } else {
      response.status(400).json({ error: "This proposal is missing an executable paper order." });
      return;
    }

    const updated = await store.updateAlgoTradeProposal(proposal.id, {
      status: "placed",
      validation,
      targetRealism: validation?.targetRealism,
      brokerOrder,
      reviewedAt: new Date().toISOString()
    });
    await store.addJournalEntry({
      symbol: proposal.symbol,
      planId: proposal.id,
      signalAsOf: proposal.signalAsOf,
      sourceType: "algo_proposal",
      sourceId: proposal.sourceAnalysisId,
      followedPlan: true,
      status: "paper_open",
      action: journalAction,
      notes: `Placed from Algo Command Center proposal: ${proposal.strategyTitle}.`,
      entryPrice,
      stopLossPrice: proposal.order?.stopLossPrice,
      takeProfitPrice: proposal.order?.takeProfitPrice,
      outcome: "open",
      expressionType: proposal.order?.side === "sell" ? "short_equity" : "long_equity",
      underlyingSymbol: proposal.symbol,
      assetClass: "equity",
      maxLoss: validation?.estimatedRisk ?? undefined,
      requiredCapital: validation?.estimatedNotional ?? undefined,
      paperExecutionMode: "broker_paper",
      brokerOrderIds: getBrokerOrderId(brokerOrder) ? [getBrokerOrderId(brokerOrder) as string] : [],
      strategyWarnings: validation?.warnings,
      strategyCategory: proposal.order?.side === "sell" ? "short_equity" : "long_equity"
    });
    response.json({ proposal: updated, validation, order: brokerOrder });
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

  app.get("/api/journal/analytics", asyncHandler(async (_request, response) => {
    response.json(buildJournalAnalytics(await store.getJournal()));
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
      maxOpenPositions: optionalNumber(request.body?.maxOpenPositions) ?? current.maxOpenPositions,
      maxOptionsContracts: optionalNumber(request.body?.maxOptionsContracts) ?? current.maxOptionsContracts,
      maxStrategyExposurePct: optionalNumber(request.body?.maxStrategyExposurePct) ?? current.maxStrategyExposurePct,
      allowZeroDte: typeof request.body?.allowZeroDte === "boolean"
        ? request.body.allowZeroDte
        : current.allowZeroDte,
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
      signalAsOf: optionalString(request.body?.signalAsOf),
      sourceType: normalizeJournalSourceType(request.body?.sourceType),
      sourceId: optionalString(request.body?.sourceId),
      followedPlan: typeof request.body?.followedPlan === "boolean" ? request.body.followedPlan : undefined,
      exitReason: normalizeJournalExitReason(request.body?.exitReason),
      status: normalizeStatus(request.body?.status),
      action: normalizeAction(request.body?.action),
      notes: String(request.body?.notes ?? ""),
      entryPrice: optionalNumber(request.body?.entryPrice),
      exitPrice: optionalNumber(request.body?.exitPrice),
      stopLossPrice: optionalNumber(request.body?.stopLossPrice),
      takeProfitPrice: optionalNumber(request.body?.takeProfitPrice),
      outcome: request.body?.outcome,
      pnl: optionalNumber(request.body?.pnl),
      expressionType: normalizeExpressionType(request.body?.expressionType),
      underlyingSymbol: optionalString(request.body?.underlyingSymbol),
      assetClass: normalizeAssetClass(request.body?.assetClass),
      optionLegs: Array.isArray(request.body?.optionLegs) ? request.body.optionLegs : undefined,
      maxLoss: optionalNumber(request.body?.maxLoss),
      maxProfit: optionalNumber(request.body?.maxProfit),
      breakeven: optionalNumber(request.body?.breakeven),
      requiredCapital: optionalNumber(request.body?.requiredCapital),
      entryThesis: optionalString(request.body?.entryThesis),
      exitThesis: optionalString(request.body?.exitThesis),
      entryMarketRegime: normalizeMarketRegime(request.body?.entryMarketRegime),
      entryScore: optionalNumber(request.body?.entryScore),
      aiConfidence: normalizeAiConfidence(request.body?.aiConfidence),
      paperExecutionMode: normalizePaperExecutionMode(request.body?.paperExecutionMode),
      brokerOrderIds: Array.isArray(request.body?.brokerOrderIds) ? request.body.brokerOrderIds.filter((id: unknown) => typeof id === "string") : undefined,
      optionsMetadata: isPlainRecord(request.body?.optionsMetadata) ? request.body.optionsMetadata : undefined,
      strategyWarnings: Array.isArray(request.body?.strategyWarnings) ? request.body.strategyWarnings.filter((warning: unknown) => typeof warning === "string") : undefined,
      realizedPnL: optionalNumber(request.body?.realizedPnL),
      actualRMultiple: optionalNumber(request.body?.actualRMultiple),
      strategyCategory: optionalString(request.body?.strategyCategory)
    });
    response.json(entry);
  }));

  app.patch("/api/journal/:id", asyncHandler(async (request, response) => {
    response.json(await store.updateJournalEntry(request.params.id, normalizeJournalPatch(request.body)));
  }));

  app.delete("/api/journal/:id", asyncHandler(async (request, response) => {
    response.json(await store.deleteJournalEntry(request.params.id));
  }));

  app.get("/api/alpaca/account", asyncHandler(async (_request, response) => {
    response.json(await alpaca.getAccount());
  }));

  app.get("/api/alpaca/positions", asyncHandler(async (_request, response) => {
    const [positions, orders] = await Promise.all([alpaca.getPositions(), alpaca.getOrders()]);
    response.json({ positions, orders });
  }));

  app.get("/api/positions/monitor", asyncHandler(async (_request, response) => {
    const [positions, orders, proposals] = await Promise.all([
      alpaca.getPositions(),
      alpaca.getOrders(),
      store.getAlgoTradeProposals(100)
    ]);
    response.json(buildPositionMonitorSnapshot({ positions, openOrders: orders, proposals }));
  }));

  app.get("/api/paper/options-simulations", asyncHandler(async (_request, response) => {
    const journal = await store.getJournal();
    const optionsByUnderlying = await getOptionsByUnderlyingForOpenSimulations(store, alpaca, journal);
    response.json(buildSimulatedOptionsSnapshot({ journal, optionsByUnderlying }));
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
    const account = await alpaca.getAccount();
    const riskProfile = getRiskProfile(account.equity ?? 100000, riskSettings);
    const orderInput = parsed.data as PaperOrderRequest;
    const referencePrice = await getReferencePrice(alpaca, orderInput.symbol);
    const validation = validatePaperOrder(orderInput, riskProfile, referencePrice);

    if (!validation.ok || !validation.order) {
      response.status(400).json(validation);
      return;
    }

    const result = await alpaca.placePaperBracketOrder(validation.order);
    const journalEntry = await store.addJournalEntry({
      symbol: orderInput.symbol,
      planId: orderInput.sourcePlanId,
      signalAsOf: orderInput.sourceSignalAsOf,
      sourceType: orderInput.sourceProposalId ? "algo_proposal" : orderInput.sourcePlanId ? "ai_plan" : "paper_order",
      sourceId: orderInput.sourceProposalId ?? orderInput.sourceAnalysisId ?? orderInput.sourcePlanId,
      followedPlan: orderInput.followedPlan,
      status: "paper_open",
      action: orderInput.side === "sell" ? "paper_short_candidate" : "paper_long_candidate",
      notes: getPaperOrderJournalNotes(orderInput, result),
      entryPrice: referencePrice ?? undefined,
      stopLossPrice: orderInput.stopLossPrice,
      takeProfitPrice: orderInput.takeProfitPrice,
      outcome: "open",
      expressionType: orderInput.side === "sell" ? "short_equity" : "long_equity",
      underlyingSymbol: orderInput.symbol,
      assetClass: "equity",
      maxLoss: validation.estimatedRisk ?? undefined,
      requiredCapital: validation.estimatedNotional ?? undefined,
      paperExecutionMode: "broker_paper",
      brokerOrderIds: getBrokerOrderId(result) ? [getBrokerOrderId(result) as string] : [],
      strategyWarnings: validation.warnings,
      strategyCategory: orderInput.side === "sell" ? "short_equity" : "long_equity"
    });
    response.json({ validation, order: result, journalEntry });
  }));

  app.post("/api/paper/multi-leg-orders", asyncHandler(async (request, response) => {
    const parsed = multiLegPaperOrderSchema.safeParse(request.body);
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

    const alpacaPaperOnly = isPaperAlpacaUrl(config.alpacaPaperBaseUrl);
    if (!alpacaPaperOnly) {
      response.status(400).json({
        ok: false,
        errors: ["Live Alpaca endpoints are blocked. Use the paper endpoint before paper options simulation."],
        warnings: [],
        estimatedNotional: null,
        estimatedRisk: null
      });
      return;
    }

    const [account, positionsResponse, journal] = await Promise.all([
      alpaca.getAccount(),
      safePositions(alpaca),
      store.getJournal()
    ]);
    const riskProfile = getRiskProfile(account.equity ?? 100000, riskSettings);
    if (parsed.data.expressionType === "covered_call" && getHeldLongShares(positionsResponse.positions, parsed.data.underlyingSymbol) < 100) {
      response.status(400).json({
        ok: false,
        errors: ["Covered calls require at least 100 long shares of the underlying."],
        warnings: [],
        estimatedNotional: null,
        estimatedRisk: null
      });
      return;
    }
    const knownContracts = await getOptionsForExpression(store, alpaca, parsed.data.underlyingSymbol);
    const missingContracts = knownContracts.length
      ? parsed.data.legs
        .map((leg) => leg.optionSymbol)
        .filter((symbol) => !knownContracts.some((contract) => contract.symbol === symbol))
      : [];
    if (missingContracts.length) {
      response.status(400).json({
        ok: false,
        errors: [`Option contract validation failed for: ${missingContracts.join(", ")}.`],
        warnings: [],
        estimatedNotional: null,
        estimatedRisk: null
      });
      return;
    }
    const validation = validateMultiLegPaperOrder(parsed.data, riskProfile, riskSettings, {
      buyingPower: account.buyingPower ?? account.cash ?? account.equity,
      alpacaPaperOnly,
      ...getOpenPaperOptionsExposure(journal, parsed.data.underlyingSymbol)
    });
    if (!knownContracts.length) {
      validation.warnings.push("Provider contract validation was unavailable; verify the contracts manually before relying on the simulation.");
    }

    if (!validation.ok || !validation.order) {
      response.status(400).json(validation);
      return;
    }

    const simulatedOrder = {
      id: `sim-options-${validation.order.underlyingSymbol}-${Date.now()}`,
      status: "internally_simulated_paper",
      paperExecutionMode: validation.order.paperExecutionMode,
      expressionType: validation.order.expressionType,
      legs: validation.order.legs
    };
    const journalEntry = await store.addJournalEntry({
      symbol: validation.order.underlyingSymbol,
      planId: validation.order.sourcePlanId,
      signalAsOf: validation.order.sourceSignalAsOf,
      sourceType: "paper_order",
      sourceId: validation.order.sourceExpressionId ?? validation.order.sourceAnalysisId ?? validation.order.sourcePlanId,
      followedPlan: validation.order.followedPlan,
      status: "paper_open",
      action: "paper_options_candidate",
      notes: getMultiLegPaperOrderJournalNotes(validation.order),
      outcome: "open",
      expressionType: validation.order.expressionType,
      underlyingSymbol: validation.order.underlyingSymbol,
      assetClass: validation.order.legs.length > 1 ? "multi_leg_option" : "option",
      optionLegs: validation.order.legs,
      maxLoss: validation.order.maxLoss,
      maxProfit: validation.order.maxProfit,
      breakeven: validation.order.breakeven,
      requiredCapital: validation.order.requiredCapital,
      paperExecutionMode: validation.order.paperExecutionMode,
      brokerOrderIds: [],
      optionsMetadata: {
        estimatedDebit: validation.order.estimatedDebit,
        estimatedCredit: validation.order.estimatedCredit,
        simulatedOrderId: simulatedOrder.id
      },
      strategyWarnings: validation.warnings,
      strategyCategory: validation.order.expressionType
    });
    response.json({ validation, order: simulatedOrder, journalEntry });
  }));

  app.post("/api/paper/options-simulations/:id/close", asyncHandler(async (request, response) => {
    if (request.body?.confirm !== "CLOSE OPTIONS SIMULATION") {
      response.status(400).json({ error: "Type CLOSE OPTIONS SIMULATION to close this internal paper options simulation." });
      return;
    }

    const journal = await store.getJournal();
    const optionsByUnderlying = await getOptionsByUnderlyingForOpenSimulations(store, alpaca, journal);
    const snapshot = buildSimulatedOptionsSnapshot({ journal, optionsByUnderlying });
    const requestedId = String(request.params.id ?? "");
    const position = snapshot.positions.find((item) => item.id === requestedId || item.journalEntryId === requestedId);
    if (!position) {
      response.status(404).json({ error: "Open options simulation not found." });
      return;
    }

    const pnl = optionalNumber(request.body?.pnl) ?? position.unrealizedPnL;
    const exitValue = optionalNumber(request.body?.exitValue) ?? position.currentValue;
    const exitReason = normalizeJournalExitReason(request.body?.exitReason) ?? "manual";
    const outcome: "win" | "loss" | "breakeven" = pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";
    const maxLoss = position.maxLoss;
    const actualRMultiple = typeof maxLoss === "number" && maxLoss > 0 ? Math.round((pnl / maxLoss) * 100) / 100 : undefined;
    const journalEntry = await store.updateJournalEntry(position.journalEntryId, {
      status: "paper_closed",
      action: "paper_options_candidate",
      notes: String(request.body?.notes ?? `Closed internal options simulation. ${position.suggestedAction}`),
      exitReason,
      exitPrice: exitValue,
      pnl,
      outcome,
      realizedPnL: pnl,
      actualRMultiple,
      exitThesis: optionalString(request.body?.exitThesis) ?? position.exitReasons[0]
    });

    response.json({
      result: {
        id: position.id,
        status: "internally_simulated_paper_closed",
        paperExecutionMode: "internal_simulation",
        brokerSubmitted: false
      },
      position,
      journalEntry
    });
  }));

  app.post("/api/alpaca/paper-orders/cancel-open", asyncHandler(async (_request, response) => {
    response.json({ result: await alpaca.cancelOpenOrders() });
  }));

  app.post("/api/alpaca/paper-positions/:symbol/close", asyncHandler(async (request, response) => {
    const symbol = String(request.params.symbol ?? "").trim();
    if (!symbol) {
      response.status(400).json({ error: "Position symbol is required." });
      return;
    }
    if (request.body?.confirm !== "CLOSE PAPER POSITION") {
      response.status(400).json({ error: "Type CLOSE PAPER POSITION to confirm this paper-only exit." });
      return;
    }

    const result = await alpaca.closePosition(symbol);
    const exitPrice = optionalNumber(request.body?.exitPrice);
    const pnl = optionalNumber(request.body?.pnl);
    const exitReason = normalizeJournalExitReason(request.body?.exitReason) ?? "manual";
    const outcome: "win" | "loss" | "breakeven" | undefined =
      pnl === undefined ? undefined : pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven";
    const journalPatch = {
      status: "paper_closed" as const,
      action: normalizeAction(request.body?.action),
      notes: String(request.body?.notes ?? "Closed from Position Monitor."),
      exitReason,
      exitPrice,
      pnl,
      outcome,
      realizedPnL: pnl
    };
    const openEntry = (await store.getJournal()).find((entry) => entry.symbol === normalizeSymbol(symbol) && entry.status === "paper_open");
    const journalEntry = openEntry
      ? await store.updateJournalEntry(openEntry.id, journalPatch)
      : await store.addJournalEntry({
      symbol,
      ...journalPatch
    });
    response.json({ result, journalEntry });
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
  const allowed: TradeAction[] = ["avoid", "watch", "paper_long_candidate", "paper_short_candidate", "paper_options_candidate", "options_research_only"];
  return allowed.includes(value as TradeAction) ? (value as TradeAction) : "watch";
}

function normalizeOptionalAction(value: unknown): TradeAction | undefined {
  const allowed: TradeAction[] = ["avoid", "watch", "paper_long_candidate", "paper_short_candidate", "paper_options_candidate", "options_research_only"];
  return allowed.includes(value as TradeAction) ? (value as TradeAction) : undefined;
}

function normalizeJournalPatch(body: unknown): Partial<Omit<TradeJournalEntry, "id" | "createdAt">> {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const patch: Partial<Omit<TradeJournalEntry, "id" | "createdAt">> = {};

  if (hasOwn(input, "status")) {
    const status = normalizeOptionalStatus(input.status);
    if (status) patch.status = status;
  }
  if (hasOwn(input, "action")) {
    const action = normalizeOptionalAction(input.action);
    if (action) patch.action = action;
  }
  if (hasOwn(input, "notes")) patch.notes = String(input.notes ?? "");
  if (hasOwn(input, "followedPlan")) patch.followedPlan = typeof input.followedPlan === "boolean" ? input.followedPlan : undefined;
  if (hasOwn(input, "exitReason")) patch.exitReason = normalizeJournalExitReason(input.exitReason);
  if (hasOwn(input, "outcome")) patch.outcome = normalizeOutcome(input.outcome);
  if (hasOwn(input, "entryPrice")) patch.entryPrice = optionalNumber(input.entryPrice);
  if (hasOwn(input, "exitPrice")) patch.exitPrice = optionalNumber(input.exitPrice);
  if (hasOwn(input, "stopLossPrice")) patch.stopLossPrice = optionalNumber(input.stopLossPrice);
  if (hasOwn(input, "takeProfitPrice")) patch.takeProfitPrice = optionalNumber(input.takeProfitPrice);
  if (hasOwn(input, "pnl")) patch.pnl = optionalNumber(input.pnl);
  if (hasOwn(input, "expressionType")) patch.expressionType = normalizeExpressionType(input.expressionType);
  if (hasOwn(input, "underlyingSymbol")) patch.underlyingSymbol = optionalString(input.underlyingSymbol);
  if (hasOwn(input, "assetClass")) patch.assetClass = normalizeAssetClass(input.assetClass);
  if (hasOwn(input, "optionLegs")) patch.optionLegs = Array.isArray(input.optionLegs) ? input.optionLegs as TradeJournalEntry["optionLegs"] : undefined;
  if (hasOwn(input, "maxLoss")) patch.maxLoss = optionalNumber(input.maxLoss);
  if (hasOwn(input, "maxProfit")) patch.maxProfit = optionalNumber(input.maxProfit);
  if (hasOwn(input, "breakeven")) patch.breakeven = optionalNumber(input.breakeven);
  if (hasOwn(input, "requiredCapital")) patch.requiredCapital = optionalNumber(input.requiredCapital);
  if (hasOwn(input, "entryThesis")) patch.entryThesis = optionalString(input.entryThesis);
  if (hasOwn(input, "exitThesis")) patch.exitThesis = optionalString(input.exitThesis);
  if (hasOwn(input, "entryMarketRegime")) patch.entryMarketRegime = normalizeMarketRegime(input.entryMarketRegime);
  if (hasOwn(input, "entryScore")) patch.entryScore = optionalNumber(input.entryScore);
  if (hasOwn(input, "aiConfidence")) patch.aiConfidence = normalizeAiConfidence(input.aiConfidence);
  if (hasOwn(input, "paperExecutionMode")) patch.paperExecutionMode = normalizePaperExecutionMode(input.paperExecutionMode);
  if (hasOwn(input, "brokerOrderIds")) patch.brokerOrderIds = Array.isArray(input.brokerOrderIds) ? input.brokerOrderIds.filter((id) => typeof id === "string") as string[] : undefined;
  if (hasOwn(input, "optionsMetadata")) patch.optionsMetadata = isPlainRecord(input.optionsMetadata) ? input.optionsMetadata : undefined;
  if (hasOwn(input, "strategyWarnings")) patch.strategyWarnings = Array.isArray(input.strategyWarnings) ? input.strategyWarnings.filter((warning) => typeof warning === "string") as string[] : undefined;
  if (hasOwn(input, "realizedPnL")) patch.realizedPnL = optionalNumber(input.realizedPnL);
  if (hasOwn(input, "actualRMultiple")) patch.actualRMultiple = optionalNumber(input.actualRMultiple);
  if (hasOwn(input, "strategyCategory")) patch.strategyCategory = optionalString(input.strategyCategory);

  return patch;
}

function normalizeStatus(value: unknown): JournalStatus {
  const allowed: JournalStatus[] = ["watching", "paper_open", "paper_closed", "skipped"];
  return allowed.includes(value as JournalStatus) ? (value as JournalStatus) : "watching";
}

function normalizeOptionalStatus(value: unknown): JournalStatus | undefined {
  const allowed: JournalStatus[] = ["watching", "paper_open", "paper_closed", "skipped"];
  return allowed.includes(value as JournalStatus) ? (value as JournalStatus) : undefined;
}

function normalizeJournalSourceType(value: unknown): JournalSourceType | undefined {
  const allowed: JournalSourceType[] = ["manual", "ai_plan", "quant_plan", "algo_proposal", "paper_order"];
  return allowed.includes(value as JournalSourceType) ? (value as JournalSourceType) : undefined;
}

function normalizeJournalExitReason(value: unknown): JournalExitReason | undefined {
  const allowed: JournalExitReason[] = ["target", "stop", "manual", "time_exit", "score_drop", "other"];
  return allowed.includes(value as JournalExitReason) ? (value as JournalExitReason) : undefined;
}

function normalizeOutcome(value: unknown): TradeJournalEntry["outcome"] | undefined {
  const allowed: Array<NonNullable<TradeJournalEntry["outcome"]>> = ["win", "loss", "breakeven", "open"];
  return allowed.includes(value as NonNullable<TradeJournalEntry["outcome"]>)
    ? (value as NonNullable<TradeJournalEntry["outcome"]>)
    : undefined;
}

function normalizeExpressionType(value: unknown): TradeExpressionType | undefined {
  const allowed: TradeExpressionType[] = [
    "long_equity",
    "short_equity",
    "long_call",
    "long_put",
    "covered_call",
    "cash_secured_put",
    "bull_call_debit_spread",
    "bear_put_debit_spread",
    "credit_spread_research",
    "iron_condor_research",
    "no_trade"
  ];
  return allowed.includes(value as TradeExpressionType) ? (value as TradeExpressionType) : undefined;
}

function normalizeAssetClass(value: unknown): AssetClass | undefined {
  const allowed: AssetClass[] = ["equity", "option", "multi_leg_option"];
  return allowed.includes(value as AssetClass) ? (value as AssetClass) : undefined;
}

function normalizePaperExecutionMode(value: unknown): PaperExecutionMode | undefined {
  const allowed: PaperExecutionMode[] = ["broker_paper", "internal_simulation", "research_only"];
  return allowed.includes(value as PaperExecutionMode) ? (value as PaperExecutionMode) : undefined;
}

function normalizeMarketRegime(value: unknown): MarketRegimeLabel | undefined {
  const allowed: MarketRegimeLabel[] = ["bullish", "neutral", "bearish", "caution"];
  return allowed.includes(value as MarketRegimeLabel) ? (value as MarketRegimeLabel) : undefined;
}

function normalizeAiConfidence(value: unknown): "low" | "medium" | "high" | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeTradeExpressionPreference(value: unknown): TradeExpressionPreference | undefined {
  const allowed: TradeExpressionPreference[] = ["simple", "defined_risk", "income", "leverage", "capital_efficient"];
  return allowed.includes(value as TradeExpressionPreference) ? (value as TradeExpressionPreference) : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
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

function normalizeBacktestRequestBody(body: unknown): BacktestRequest | null {
  const request = body as Partial<BacktestRequest> | undefined;
  const symbols = Array.isArray(request?.symbols)
    ? request.symbols.map((symbol) => normalizeSymbol(String(symbol))).filter(Boolean).slice(0, 25)
    : [];
  const startDate = typeof request?.startDate === "string" ? request.startDate.slice(0, 10) : "";
  const endDate = typeof request?.endDate === "string" ? request.endDate.slice(0, 10) : "";
  if (!symbols.length || !isValidDateKey(startDate) || !isValidDateKey(endDate) || startDate > endDate) return null;

  return {
    symbols,
    startDate,
    endDate,
    holdingPeriodDays: optionalNumber(request?.holdingPeriodDays) ?? 10,
    maxPositions: optionalNumber(request?.maxPositions) ?? 3,
    minScore: optionalNumber(request?.minScore) ?? 70,
    initialEquity: optionalNumber(request?.initialEquity),
    riskPerTradePct: optionalNumber(request?.riskPerTradePct),
    maxPositionPct: optionalNumber(request?.maxPositionPct),
    minRiskReward: optionalNumber(request?.minRiskReward),
    marketRegimeFilter: Array.isArray(request?.marketRegimeFilter) ? request.marketRegimeFilter : undefined
  };
}

function getBacktestBarsOptions(request: BacktestRequest): { limit: number; start: string; end: string } {
  const start = new Date(`${request.startDate}T00:00:00.000Z`);
  const end = new Date(`${request.endDate}T23:59:59.000Z`);
  start.setDate(start.getDate() - 340);
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
  return {
    limit: Math.min(5000, Math.max(260, Math.ceil(days * 1.8))),
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime());
}

function getPaperTradingBlockedReasons(input: {
  alpacaConfigured: boolean;
  alpacaPaperOnly: boolean;
  killSwitchEnabled: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!input.alpacaPaperOnly) reasons.push("Alpaca live trading URL is blocked.");
  if (!input.alpacaConfigured) reasons.push("Alpaca paper credentials are missing.");
  if (input.killSwitchEnabled) reasons.push("Paper order kill switch is enabled.");
  return reasons;
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

function getHeldLongShares(positions: unknown[], symbol: string): number {
  return positions.reduce<number>((sum, position) => {
    if (!position || typeof position !== "object") return sum;
    const rawSymbol = (position as { symbol?: unknown }).symbol;
    if (typeof rawSymbol !== "string" || rawSymbol.toUpperCase() !== symbol.toUpperCase()) return sum;
    const side = String((position as { side?: unknown }).side ?? "long").toLowerCase();
    if (side === "short") return sum;
    const qty = Number((position as { qty?: unknown; quantity?: unknown }).qty ?? (position as { quantity?: unknown }).quantity ?? 0);
    return Number.isFinite(qty) && qty > 0 ? sum + qty : sum;
  }, 0);
}

function getOpenPaperOptionsExposure(journal: TradeJournalEntry[], underlyingSymbol: string) {
  const normalizedUnderlying = normalizeSymbol(underlyingSymbol);
  const openEntries = journal.filter((entry) => entry.status === "paper_open");
  const openOptionsEntries = openEntries.filter((entry) => entry.paperExecutionMode === "internal_simulation" && entry.optionLegs?.length);
  return {
    openPaperPositionCount: openEntries.length,
    existingOptionsContracts: openOptionsEntries.reduce((sum, entry) => (
      sum + (entry.optionLegs ?? []).reduce((contractSum, leg) => contractSum + leg.quantity, 0)
    ), 0),
    existingUnderlyingRequiredCapital: openOptionsEntries
      .filter((entry) => normalizeSymbol(entry.underlyingSymbol ?? entry.symbol) === normalizedUnderlying)
      .reduce((sum, entry) => sum + (entry.requiredCapital ?? 0), 0)
  };
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

async function getMarketRegimeSnapshot(alpaca: AlpacaClient) {
  const [spyBars, qqqBars] = await Promise.all([
    alpaca.getBars("SPY"),
    alpaca.getBars("QQQ")
  ]);
  return buildMarketRegimeSnapshot({ spyBars, qqqBars });
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

function getPaperOrderJournalNotes(order: PaperOrderRequest, brokerOrder: unknown): string {
  const pieces = ["Paper bracket order submitted."];
  if (order.sourcePlanId) pieces.push(`Source plan ${order.sourcePlanId}.`);
  if (order.sourceAnalysisId) pieces.push(`Source analysis ${order.sourceAnalysisId}.`);
  if (order.sourceProposalId) pieces.push(`Source proposal ${order.sourceProposalId}.`);
  if (typeof order.followedPlan === "boolean") {
    pieces.push(order.followedPlan ? "Marked as following the plan." : "Marked as deviating from the plan.");
  }
  const brokerId = getBrokerOrderId(brokerOrder);
  if (brokerId) pieces.push(`Broker order ${brokerId}.`);
  return pieces.join(" ");
}

function getMultiLegPaperOrderJournalNotes(order: MultiLegPaperOrderRequest): string {
  const pieces = [
    "Options paper trade created as an internal simulation.",
    "No live options order or broker options order was submitted.",
    `${order.expressionType.replaceAll("_", " ")} with ${order.legs.length} leg${order.legs.length === 1 ? "" : "s"}.`,
    `Max loss acknowledged: ${order.maxLoss}.`
  ];
  if (order.estimatedDebit !== undefined) pieces.push(`Estimated debit ${order.estimatedDebit}.`);
  if (order.estimatedCredit !== undefined) pieces.push(`Estimated credit ${order.estimatedCredit}.`);
  if (order.sourceExpressionId) pieces.push(`Source expression ${order.sourceExpressionId}.`);
  return pieces.join(" ");
}

function getBrokerOrderId(order: unknown): string | null {
  if (!order || typeof order !== "object") return null;
  const id = (order as { id?: unknown; client_order_id?: unknown }).id ?? (order as { client_order_id?: unknown }).client_order_id;
  return typeof id === "string" ? id : null;
}

function enforceSafetyOnVerdict<T extends { action: TradeAction; warnings: string[] }>(verdict: T, blockers: Array<{ severity: string; message: string }>): T {
  if (!blockers.some((blocker) => blocker.severity === "blocker")) return verdict;
  return {
    ...verdict,
    action: verdict.action === "avoid" ? "avoid" : "watch",
    warnings: [...new Set([...verdict.warnings, ...blockers.map((blocker) => blocker.message)])]
  };
}

async function getAlgoProposal(store: AppStore, id: string): Promise<AlgoTradeProposal> {
  const proposal = (await store.getAlgoTradeProposals(100)).find((item) => item.id === id);
  if (!proposal) throw new Error("Algo trade proposal not found.");
  return proposal;
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

async function getOptionsForExpression(store: AppStore, alpaca: AlpacaClient, symbol: string) {
  const cached = await store.getCachedOptionIdeas(symbol, OPTIONS_CACHE_MS);
  if (cached) return cached;
  try {
    const [ideas, bars] = await Promise.all([
      alpaca.getOptionIdeas(symbol),
      alpaca.getBars(symbol, 5).catch(() => [])
    ]);
    const enriched = enrichOptionIdeas(ideas, bars.at(-1)?.close ?? null);
    await store.saveOptionIdeas(symbol, enriched);
    return enriched;
  } catch {
    return [];
  }
}

async function getOptionsByUnderlyingForOpenSimulations(
  store: AppStore,
  alpaca: AlpacaClient,
  journal: TradeJournalEntry[]
) {
  const underlyings = [...new Set(journal
    .filter((entry) => entry.status === "paper_open" && entry.paperExecutionMode === "internal_simulation" && entry.optionLegs?.length)
    .map((entry) => normalizeSymbol(entry.underlyingSymbol ?? entry.symbol))
    .filter(Boolean)
  )];
  const entries = await Promise.all(underlyings.map(async (symbol) => [
    symbol,
    await getOptionsForExpression(store, alpaca, symbol)
  ] as const));
  return Object.fromEntries(entries);
}
