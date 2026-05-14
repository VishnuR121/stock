import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  HelpCircle,
  LineChart,
  Loader2,
  Moon,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Target,
  Trash2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AlgoTradeProposal,
  AnalysisRun,
  BacktestResult,
  BrokerAccountSnapshot,
  DeterministicTradePlan,
  EnrichedTradePlanResponse,
  HealthStatus,
  JournalAnalytics,
  MarketRegimeLabel,
  MarketRegimeSnapshot,
  OpportunityCandidate,
  OpportunityScan,
  OptionIdea,
  PaperOrderRequest,
  PositionMonitorSnapshot,
  MonitoredPosition,
  RiskSettings,
  SavedTradePlan,
  SignalSnapshot,
  TradeAction,
  TradeHorizon,
  TradeContext,
  TradeJournalEntry,
  TradePlan,
  WatchlistItem
} from "./shared/types";
import {
  checkDayOrderTargetRealism,
  deriveTradeHorizon,
  expectedHoldingPeriod,
  formatHorizon,
  selectDefaultTimeInForce
} from "./shared/orderHorizon";

type PositionsResponse = {
  positions: unknown[];
  orders: unknown[];
};

type BeginnerAction = {
  label: string;
  tone: "good" | "warn" | "danger" | "neutral";
  action: string;
  why: string;
  options: string;
};
type ThemeMode = "light" | "dark";
type AnalysisView = "decision" | "plan";
type WorkspaceView = "overview" | "research" | "backtests" | "algo" | "positions" | "orders" | "account";
type AlgoQueueFilter = "active" | "selected" | "all" | "history";

type BacktestForm = {
  symbols: string;
  startDate: string;
  endDate: string;
  holdingPeriodDays: number;
  maxPositions: number;
  minScore: number;
  marketRegimeFilter: MarketRegimeLabel[];
};

const emptyOrder: PaperOrderRequest = {
  symbol: "",
  side: "buy",
  orderType: "market",
  quantity: 1,
  stopLossPrice: 0,
  takeProfitPrice: 0,
  timeInForce: "day",
  horizon: "intraday",
  earningsChecked: false,
  confirmedPaperOnly: false,
  acceptedRisk: false
};

const defaultBacktestForm: BacktestForm = {
  symbols: "SPY, QQQ, AAPL, MSFT",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  holdingPeriodDays: 10,
  maxPositions: 3,
  minScore: 70,
  marketRegimeFilter: []
};

export function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [newSymbol, setNewSymbol] = useState("");
  const [snapshots, setSnapshots] = useState<SignalSnapshot[]>([]);
  const [activeSignal, setActiveSignal] = useState<SignalSnapshot | null>(null);
  const [analysisRuns, setAnalysisRuns] = useState<Record<string, AnalysisRun>>({});
  const [tradePlans, setTradePlans] = useState<Record<string, SavedTradePlan>>({});
  const [quantPlans, setQuantPlans] = useState<Record<string, DeterministicTradePlan>>({});
  const [journal, setJournal] = useState<TradeJournalEntry[]>([]);
  const [journalAnalytics, setJournalAnalytics] = useState<JournalAnalytics | null>(null);
  const [opportunityScan, setOpportunityScan] = useState<OpportunityScan | null>(null);
  const [algoProposals, setAlgoProposals] = useState<AlgoTradeProposal[]>([]);
  const [positionMonitor, setPositionMonitor] = useState<PositionMonitorSnapshot | null>(null);
  const [optionsBySymbol, setOptionsBySymbol] = useState<Record<string, OptionIdea[]>>({});
  const [contextsBySymbol, setContextsBySymbol] = useState<Record<string, TradeContext>>({});
  const [account, setAccount] = useState<BrokerAccountSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionsResponse | null>(null);
  const [riskSettings, setRiskSettings] = useState<RiskSettings | null>(null);
  const [marketRegime, setMarketRegime] = useState<MarketRegimeSnapshot | null>(null);
  const [orderDraft, setOrderDraft] = useState<PaperOrderRequest>(emptyOrder);
  const [reviewingOrder, setReviewingOrder] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  const [analysisView, setAnalysisView] = useState<AnalysisView>("decision");
  const [opportunityOpen, setOpportunityOpen] = useState(true);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("overview");
  const [algoQueueFilter, setAlgoQueueFilter] = useState<AlgoQueueFilter>("active");
  const [algoSearch, setAlgoSearch] = useState("");
  const [backtestForm, setBacktestForm] = useState<BacktestForm>(defaultBacktestForm);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);

  useEffect(() => {
    void refreshBasics();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("stocks-theme", theme);
    } catch {
      // Ignore storage failures and keep runtime theme.
    }
  }, [theme]);

  useEffect(() => {
    if (!activeSignal) return;
    const horizon = deriveTradeHorizon({ signal: activeSignal });
    setOrderDraft((draft) => ({
      ...draft,
      symbol: activeSignal.symbol,
      stopLossPrice: activeSignal.suggestedStop ?? draft.stopLossPrice,
      takeProfitPrice: activeSignal.suggestedTarget ?? draft.takeProfitPrice,
      horizon,
      timeInForce: selectDefaultTimeInForce({ horizon, assetClass: "stock" })
    }));
    void loadContext(activeSignal.symbol);
    void loadOptions(activeSignal.symbol);
    void loadAnalysisHistory(activeSignal.symbol);
    void loadQuantPlan(activeSignal);
  }, [activeSignal]);

  const sortedSnapshots = useMemo(() => {
    return [...snapshots].sort((left, right) => right.score - left.score);
  }, [snapshots]);
  const activePlanRecord = activeSignal ? tradePlans[activeSignal.symbol] : undefined;
  const activeTradePlan = activePlanRecord?.plan ?? null;
  const activeQuantPlan = activeSignal ? quantPlans[activeSignal.symbol] ?? null : null;
  const activeAnalysis = activeSignal ? analysisRuns[activeSignal.symbol] : null;
  const activeContext = activeSignal ? contextsBySymbol[activeSignal.symbol] ?? activeAnalysis?.context ?? activePlanRecord?.context ?? null : null;
  const activeOptions = activeSignal ? optionsBySymbol[activeSignal.symbol] ?? [] : [];
  const orderReferencePrice = orderDraft.orderType === "limit" ? orderDraft.limitPrice ?? null : activeSignal?.lastPrice ?? null;
  const orderTargetRealism = checkDayOrderTargetRealism({
    order: orderDraft,
    referencePrice: orderReferencePrice
  });

  async function refreshBasics() {
    setBusy("refresh");
    setMessage(null);
    try {
      const [healthData, watchlistData] = await Promise.all([
        api<HealthStatus>("/api/health"),
        api<WatchlistItem[]>("/api/watchlist")
      ]);
      setHealth(healthData);
      setWatchlist(watchlistData);
      await Promise.all([
        loadAccount(),
        loadPositions(),
        loadSavedPlans(),
        loadJournal(),
        loadRiskSettings(),
        loadAlgoProposals(),
        loadPositionMonitor(),
        loadMarketRegime()
      ]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function loadAccount() {
    try {
      setAccount(await api<BrokerAccountSnapshot>("/api/alpaca/account"));
    } catch {
      setAccount(null);
    }
  }

  async function loadPositions() {
    try {
      setPositions(await api<PositionsResponse>("/api/alpaca/positions"));
    } catch {
      setPositions(null);
    }
  }

  async function loadSavedPlans() {
    try {
      const savedPlans = await api<Record<string, SavedTradePlan>>("/api/trade-plans");
      setTradePlans(savedPlans);
      setContextsBySymbol((current) => ({
        ...Object.fromEntries(Object.entries(savedPlans).map(([symbol, plan]) => [symbol, plan.context])),
        ...current
      }));
    } catch {
      setTradePlans({});
    }
  }

  async function loadJournal() {
    try {
      setJournal(await api<TradeJournalEntry[]>("/api/journal"));
      setJournalAnalytics(await api<JournalAnalytics>("/api/journal/analytics"));
    } catch {
      setJournal([]);
      setJournalAnalytics(null);
    }
  }

  async function loadAlgoProposals() {
    try {
      setAlgoProposals(await api<AlgoTradeProposal[]>("/api/algo/proposals"));
    } catch {
      setAlgoProposals([]);
    }
  }

  async function loadPositionMonitor() {
    try {
      setPositionMonitor(await api<PositionMonitorSnapshot>("/api/positions/monitor"));
    } catch {
      setPositionMonitor(null);
    }
  }

  async function loadRiskSettings() {
    try {
      setRiskSettings(await api<RiskSettings>("/api/settings/risk"));
    } catch {
      setRiskSettings(null);
    }
  }

  async function loadMarketRegime() {
    try {
      setMarketRegime(await api<MarketRegimeSnapshot>("/api/market/regime"));
    } catch {
      setMarketRegime(null);
    }
  }

  async function saveWatchlist(next: WatchlistItem[]) {
    setBusy("watchlist");
    setMessage(null);
    try {
      const saved = await api<WatchlistItem[]>("/api/watchlist", {
        method: "POST",
        body: JSON.stringify({ watchlist: next })
      });
      setWatchlist(saved);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function addSymbol(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const symbol = newSymbol.trim().toUpperCase();
    if (!symbol || watchlist.some((item) => item.symbol === symbol)) return;
    await saveWatchlist([
      ...watchlist,
      {
        symbol,
        tags: [],
        createdAt: new Date().toISOString()
      }
    ]);
    setNewSymbol("");
  }

  async function runScan() {
    setBusy("scan");
    setMessage(null);
    try {
      const result = await api<{ snapshots: SignalSnapshot[] }>("/api/scan", {
        method: "POST",
        body: JSON.stringify({ symbols: watchlist.map((item) => item.symbol) })
      });
      setSnapshots(result.snapshots);
      setActiveSignal(result.snapshots[0] ?? null);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function findOpportunities(forceRefresh = false) {
    setBusy(forceRefresh ? "opportunity-refresh" : "opportunity");
    setMessage(null);
    try {
      const result = await api<{ scan: OpportunityScan; cached: boolean }>("/api/opportunities/scan", {
        method: "POST",
        body: JSON.stringify({ forceRefresh })
      });
      setOpportunityScan(result.scan);
      setMessage(result.cached ? "Loaded today's cached opportunities." : "Opportunity scan complete.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function analyzeOpportunity(candidate: OpportunityCandidate) {
    setActiveSignal(candidate.snapshot);
    setSnapshots((current) => {
      const without = current.filter((item) => item.symbol !== candidate.symbol);
      return [candidate.snapshot, ...without];
    });
    setAnalysisView("decision");
    setMessage(`${candidate.symbol} loaded for analysis.`);
  }

  async function addOpportunityToWatchlist(candidate: OpportunityCandidate) {
    if (watchlist.some((item) => item.symbol === candidate.symbol)) {
      setMessage(`${candidate.symbol} is already on the watchlist.`);
      return;
    }
    await saveWatchlist([
      ...watchlist,
      {
        symbol: candidate.symbol,
        tags: ["Opportunity"],
        notes: candidate.reason,
        createdAt: new Date().toISOString()
      }
    ]);
    setMessage(`${candidate.symbol} added to the watchlist.`);
  }

  async function runOpportunityScan(candidate: OpportunityCandidate) {
    setBusy(`opportunity-scan-${candidate.symbol}`);
    setMessage(null);
    try {
      const result = await api<{ snapshots: SignalSnapshot[] }>("/api/scan", {
        method: "POST",
        body: JSON.stringify({ symbols: [candidate.symbol] })
      });
      const next = result.snapshots[0] ?? candidate.snapshot;
      setSnapshots((current) => {
        const without = current.filter((item) => item.symbol !== next.symbol);
        return [next, ...without];
      });
      setActiveSignal(next);
      setMessage(`${candidate.symbol} scan refreshed.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function loadSymbol(symbol: string) {
    const cached = snapshots.find((snapshot) => snapshot.symbol === symbol);
    if (cached) {
      setActiveSignal(cached);
      return;
    }

    setBusy(`symbol-${symbol}`);
    setMessage(null);
    try {
      const result = await api<{ signal: SignalSnapshot }>(`/api/symbol/${symbol}`);
      setActiveSignal(result.signal);
      setSnapshots((current) => {
        const without = current.filter((item) => item.symbol !== symbol);
        return [result.signal, ...without];
      });
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function loadOptions(symbol: string) {
    if (optionsBySymbol[symbol]) return;
    try {
      const result = await api<{ ideas: OptionIdea[] }>(`/api/options/${symbol}`);
      setOptionsBySymbol((current) => ({ ...current, [symbol]: result.ideas }));
    } catch {
      setOptionsBySymbol((current) => ({ ...current, [symbol]: [] }));
    }
  }

  async function loadContext(symbol: string) {
    if (contextsBySymbol[symbol]) return;
    try {
      const result = await api<TradeContext>(`/api/context/${symbol}`);
      setContextsBySymbol((current) => ({ ...current, [symbol]: result }));
    } catch {
      // Context helps the review flow, but missing it should not block a symbol.
    }
  }

  async function loadAnalysisHistory(symbol: string) {
    try {
      const runs = await api<AnalysisRun[]>(`/api/analysis-runs/${symbol}`);
      if (runs[0]) {
        setAnalysisRuns((current) => ({ ...current, [symbol]: runs[0] }));
        setContextsBySymbol((current) => ({ ...current, [symbol]: current[symbol] ?? runs[0].context }));
      }
    } catch {
      // Analysis runs are an enhancement; missing history should not block symbol review.
    }
  }

  async function loadQuantPlan(snapshot: SignalSnapshot) {
    try {
      const plan = await api<DeterministicTradePlan>("/api/trade-plan/deterministic", {
        method: "POST",
        body: JSON.stringify({ snapshot })
      });
      setQuantPlans((current) => ({ ...current, [snapshot.symbol]: plan }));
    } catch {
      setQuantPlans((current) => {
        const next = { ...current };
        delete next[snapshot.symbol];
        return next;
      });
    }
  }

  async function generateTradePlan() {
    if (!activeSignal) return;
    setBusy("ai");
    setMessage(null);
    try {
      const result = await api<EnrichedTradePlanResponse>("/api/ai/trade-plan", {
        method: "POST",
        body: JSON.stringify({ snapshot: activeSignal })
      });
      setTradePlans((current) => {
        return {
          ...current,
          [activeSignal.symbol]: result.savedPlan
        };
      });
      setContextsBySymbol((current) => ({ ...current, [activeSignal.symbol]: result.context }));
      if (result.quantitativePlan) {
        setQuantPlans((current) => ({ ...current, [activeSignal.symbol]: result.quantitativePlan as DeterministicTradePlan }));
      }
      setAnalysisView("plan");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function generateAnalysisRun() {
    if (!activeSignal) return;
    setBusy("analysis");
    setMessage(null);
    try {
      const result = await api<{ analysisRun: AnalysisRun }>("/api/ai/analysis-run", {
        method: "POST",
        body: JSON.stringify({ snapshot: activeSignal, mode: "fast" })
      });
      setAnalysisRuns((current) => ({ ...current, [activeSignal.symbol]: result.analysisRun }));
      setContextsBySymbol((current) => ({ ...current, [activeSignal.symbol]: result.analysisRun.context }));
      setAnalysisView("decision");
      setMessage("Decision Center analysis saved.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function generateAlgoProposals() {
    if (!activeSignal) return;
    setBusy("algo");
    setMessage(null);
    try {
      const result = await api<{ analysisRun: AnalysisRun; proposals: AlgoTradeProposal[] }>("/api/algo/proposals", {
        method: "POST",
        body: JSON.stringify({ snapshot: activeSignal, mode: "fast" })
      });
      setAnalysisRuns((current) => ({ ...current, [activeSignal.symbol]: result.analysisRun }));
      setContextsBySymbol((current) => ({ ...current, [activeSignal.symbol]: result.analysisRun.context }));
      setAlgoProposals((current) => {
        const ids = new Set(result.proposals.map((proposal) => proposal.id));
        return [...result.proposals, ...current.filter((proposal) => !ids.has(proposal.id))];
      });
      setAnalysisView("decision");
      setMessage("Algo proposals added to the approval queue.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function executeAlgoProposal(proposal: AlgoTradeProposal) {
    setBusy(`algo-execute-${proposal.id}`);
    setMessage(null);
    try {
      const result = await api<{ proposal: AlgoTradeProposal }>(`/api/algo/proposals/${proposal.id}/execute`, {
        method: "POST",
        body: JSON.stringify({
          earningsChecked: true,
          confirmedPaperOnly: true,
          acceptedRisk: true
        })
      });
      setAlgoProposals((current) => current.map((item) => item.id === proposal.id ? result.proposal : item));
      setMessage(`${proposal.symbol} paper order placed from approved algo proposal.`);
      await Promise.all([loadAccount(), loadPositions(), loadJournal(), loadPositionMonitor()]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function rejectAlgoProposal(proposal: AlgoTradeProposal) {
    setBusy(`algo-reject-${proposal.id}`);
    setMessage(null);
    try {
      const result = await api<{ proposal: AlgoTradeProposal }>(`/api/algo/proposals/${proposal.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: "Rejected from dashboard." })
      });
      setAlgoProposals((current) => current.map((item) => item.id === proposal.id ? result.proposal : item));
      setMessage(`${proposal.symbol} algo proposal rejected.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function deleteAlgoProposal(proposal: AlgoTradeProposal) {
    setBusy(`algo-delete-${proposal.id}`);
    setMessage(null);
    try {
      await api<{ id: string }>(`/api/algo/proposals/${proposal.id}`, {
        method: "DELETE"
      });
      setAlgoProposals((current) => current.filter((item) => item.id !== proposal.id));
      setMessage(`${proposal.symbol} algo proposal deleted.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function deleteJournalEntry(entry: TradeJournalEntry) {
    setBusy(`journal-delete-${entry.id}`);
    setMessage(null);
    try {
      await api<{ id: string }>(`/api/journal/${entry.id}`, {
        method: "DELETE"
      });
      setJournal((current) => current.filter((item) => item.id !== entry.id));
      setMessage(`${entry.symbol} journal entry deleted.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function setKillSwitch(enabled: boolean) {
    if (!riskSettings) return;
    setBusy("risk");
    setMessage(null);
    try {
      const saved = await api<RiskSettings>("/api/settings/risk", {
        method: "POST",
        body: JSON.stringify({ ...riskSettings, killSwitchEnabled: enabled })
      });
      setRiskSettings(saved);
      setMessage(enabled ? "Paper order kill switch enabled." : "Paper order kill switch disabled.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancelOpenPaperOrders() {
    setBusy("cancel-orders");
    setMessage(null);
    try {
      await api("/api/alpaca/paper-orders/cancel-open", { method: "POST", body: JSON.stringify({}) });
      setMessage("Open paper orders canceled.");
      await Promise.all([loadPositions(), loadPositionMonitor()]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function flattenPaperPositions() {
    const confirm = window.prompt("Type FLATTEN PAPER POSITIONS to close all Alpaca paper positions.");
    if (confirm !== "FLATTEN PAPER POSITIONS") return;
    setBusy("flatten-positions");
    setMessage(null);
    try {
      await api("/api/alpaca/paper-positions/flatten", {
        method: "POST",
        body: JSON.stringify({ confirm })
      });
      setMessage("Flatten paper positions request sent.");
      await Promise.all([loadAccount(), loadPositions(), loadPositionMonitor()]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function addJournalFromPlan(status: "watching" | "skipped") {
    if (!activeSignal || !activePlanRecord) return;
    setBusy("journal");
    setMessage(null);
    try {
      const entry = await api<TradeJournalEntry>("/api/journal", {
        method: "POST",
        body: JSON.stringify({
          symbol: activeSignal.symbol,
          planId: activePlanRecord.id,
          status,
          action: activePlanRecord.plan.action ?? "watch",
          notes: status === "watching" ? "Added from AI plan for follow-up." : "Skipped from AI plan.",
          entryPrice: activeSignal.lastPrice,
          stopLossPrice: activeSignal.suggestedStop,
          takeProfitPrice: activeSignal.suggestedTarget
        })
      });
      setJournal((current) => [entry, ...current]);
      setMessage(status === "watching" ? "Added to trade journal watchlist." : "Recorded as skipped in the journal.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function submitPaperOrder() {
    setBusy("order");
    setMessage(null);
    try {
      const result = await api<{ journalEntry?: TradeJournalEntry }>("/api/alpaca/paper-orders", {
        method: "POST",
        body: JSON.stringify({
          ...orderDraft,
          sourcePlanId: activePlanRecord?.id,
          sourceSignalAsOf: activeSignal?.asOf,
          followedPlan: activeSignal ? orderMatchesActivePlan(orderDraft, activeSignal, activeQuantPlan) : undefined
        })
      });
      setReviewingOrder(false);
      setMessage("Paper bracket order submitted.");
      if (result.journalEntry) {
        setJournal((current) => [result.journalEntry as TradeJournalEntry, ...current.filter((entry) => entry.id !== result.journalEntry?.id)]);
      }
      await Promise.all([loadAccount(), loadPositions(), loadJournal(), loadPositionMonitor()]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function refreshPositionMonitor() {
    setBusy("position-monitor");
    setMessage(null);
    try {
      await Promise.all([loadPositions(), loadPositionMonitor()]);
      setMessage("Position monitor refreshed.");
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function runBacktest() {
    setBusy("backtest");
    setMessage(null);
    try {
      const result = await api<BacktestResult>("/api/backtest", {
        method: "POST",
        body: JSON.stringify({
          symbols: backtestForm.symbols.split(",").map((symbol) => symbol.trim()).filter(Boolean),
          startDate: backtestForm.startDate,
          endDate: backtestForm.endDate,
          holdingPeriodDays: backtestForm.holdingPeriodDays,
          maxPositions: backtestForm.maxPositions,
          minScore: backtestForm.minScore,
          marketRegimeFilter: backtestForm.marketRegimeFilter.length ? backtestForm.marketRegimeFilter : undefined
        })
      });
      setBacktestResult(result);
      setMessage(`Backtest complete: ${result.numberOfTrades} trades.`);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function closeMonitoredPosition(position: MonitoredPosition) {
    const confirm = window.prompt(`Type CLOSE PAPER POSITION to close ${position.symbol}.`);
    if (confirm !== "CLOSE PAPER POSITION") return;
    setBusy(`close-position-${position.symbol}`);
    setMessage(null);
    try {
      await api(`/api/alpaca/paper-positions/${encodeURIComponent(position.symbol)}/close`, {
        method: "POST",
        body: JSON.stringify({
          confirm,
          action: position.executionType === "long_option" ? "options_research_only" : position.side === "short" ? "paper_short_candidate" : "paper_long_candidate",
          exitPrice: position.currentPrice,
          pnl: position.unrealizedPl,
          notes: `Closed from Position Monitor. ${position.suggestedAction}`
        })
      });
      setMessage(`${position.symbol} close request sent.`);
      await Promise.all([loadAccount(), loadPositions(), loadJournal(), loadPositionMonitor()]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const signalPanel = (
    <section className="panel">
      <div className="panelTitle">
        <Target size={18} />
        <div>
          <h2>Signals</h2>
          <p>Setup score is 0-100. Higher means cleaner conditions, not an automatic buy.</p>
        </div>
      </div>
      <div className="signalGrid">
        {(sortedSnapshots.length ? sortedSnapshots : watchlistPreview(watchlist)).map((signal) => (
          <SignalCard
            key={signal.symbol}
            signal={signal}
            active={activeSignal?.symbol === signal.symbol}
            loading={busy === `symbol-${signal.symbol}`}
            onSelect={() => {
              setWorkspaceView("research");
              return isFullSignal(signal) ? setActiveSignal(signal) : loadSymbol(signal.symbol);
            }}
          />
        ))}
      </div>
    </section>
  );

  const detailPanel = (
    <section className="panel detailPanel">
      <div className="panelTitle spaced detailHeader">
        <div className="detailHeading">
          <h2>{activeSignal?.symbol ?? "Symbol detail"}</h2>
          <p>{activeSignal ? `${activeSignal.trend} - ${activeSignal.bias}` : "Select a ticker"}</p>
        </div>
        <div className="detailActions">
          <button className="textButton" onClick={generateTradePlan} disabled={!activeSignal || busy === "ai"}>
            {busy === "ai" ? <Loader2 className="spin" size={17} /> : <Bot size={17} />}
            <span>{activeSignal && activePlanRecord ? "Refresh plan" : "AI plan"}</span>
          </button>
          <button className="textButton secondary" onClick={generateAnalysisRun} disabled={!activeSignal || busy === "analysis"}>
            {busy === "analysis" ? <Loader2 className="spin" size={17} /> : <ShieldCheck size={17} />}
            <span>Decision Center</span>
          </button>
        </div>
      </div>

      {activeSignal ? (
        <>
          <BeginnerGuidance signal={activeSignal} plan={activeTradePlan} />
          <QuantPlanCard plan={activeQuantPlan} signal={activeSignal} />
          <Sparkline bars={activeSignal.bars} />
          <MetricStrip signal={activeSignal} />
          <div className="notes">
            {activeSignal.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>

          <div className="analysisTabs">
            <button
              className={`tabButton ${analysisView === "decision" ? "active" : ""}`}
              onClick={() => setAnalysisView("decision")}
            >
              Decision Center
            </button>
            <button
              className={`tabButton ${analysisView === "plan" ? "active" : ""}`}
              onClick={() => setAnalysisView("plan")}
            >
              AI Plan
            </button>
          </div>

          {analysisView === "decision" ? (
            <section className="analysisSurface">
              <div className="panelTitle compact">
                <ShieldCheck size={18} />
                <p>Deterministic reports feed one manager synthesis. Safety blockers win.</p>
              </div>
              {activeAnalysis ? (
                <DecisionCenter analysis={activeAnalysis} />
              ) : (
                <EmptyState text="Run Decision Center from an active signal" />
              )}
            </section>
          ) : (
            <section className="analysisSurface">
              <div className="panelTitle compact">
                <Bot size={18} />
                <div>
                  <h2>AI trade plan</h2>
                  {activePlanRecord && (
                    <p>
                      Saved for {activePlanRecord.plan.symbol} at {formatDateTime(activePlanRecord.createdAt)}
                      {activeSignal && activePlanRecord.signalAsOf !== activeSignal.asOf ? " - scan changed, refresh when ready" : ""}
                    </p>
                  )}
                </div>
              </div>
              {activeTradePlan ? (
                <TradePlanView
                  plan={activeTradePlan}
                  signal={activeSignal}
                  savedPlan={activePlanRecord}
                  onJournal={addJournalFromPlan}
                  busy={busy === "journal"}
                />
              ) : (
                <EmptyState text="Generate a plan from an active signal" />
              )}
            </section>
          )}
        </>
      ) : (
        <EmptyState text="No signal loaded" />
      )}
    </section>
  );

  const orderPanel = (
    <section className="panel compactPanel">
      <div className="panelTitle">
        <ClipboardCheck size={18} />
        <h2>Paper order</h2>
      </div>
      <PaperOrderForm
        activeSignal={activeSignal}
        orderDraft={orderDraft}
        setOrderDraft={setOrderDraft}
        targetRealism={orderTargetRealism}
        onReview={() => setReviewingOrder(true)}
      />
    </section>
  );

  const safetyPanel = (
    <section className="panel compactPanel">
      <div className="panelTitle spaced">
        <div>
          <h2>Safety controls</h2>
          <p>Paper-only emergency controls and risk lockout.</p>
        </div>
        <button className={`textButton ${riskSettings?.killSwitchEnabled ? "danger" : "secondary"}`} onClick={() => setKillSwitch(!riskSettings?.killSwitchEnabled)} disabled={!riskSettings || busy === "risk"}>
          <ShieldCheck size={16} />
          <span>{riskSettings?.killSwitchEnabled ? "Disable kill switch" : "Enable kill switch"}</span>
        </button>
      </div>
      <SafetyControls riskSettings={riskSettings} onCancelOrders={cancelOpenPaperOrders} onFlattenPositions={flattenPaperPositions} busy={busy} />
    </section>
  );

  const contextPanel = (
    <section className="panel compactPanel">
      <div className="panelTitle">
        <Settings size={18} />
        <h2>Context + options</h2>
      </div>
      <ContextPanel context={activeContext ?? undefined} />
      <OptionsTable options={activeOptions} />
    </section>
  );

  const accountPanel = (
    <section className="panel compactPanel">
      <details className="collapseBlock" open>
        <summary>
          <Activity size={16} />
          <span>Paper account</span>
          <ChevronDown className="summaryChevron" size={16} />
        </summary>
        <div className="collapseBody">
          <AccountPanel account={account} positions={positions} />
        </div>
      </details>
    </section>
  );

  const journalPanel = (
    <section className="panel compactPanel">
      <div className="panelTitle">
        <ClipboardCheck size={18} />
        <h2>Trade journal</h2>
      </div>
      <JournalAnalyticsSummary analytics={journalAnalytics} />
      <JournalList journal={journal} busy={busy} onDelete={deleteJournalEntry} />
    </section>
  );

  return (
    <main className="shell">
      <section className="topbar" aria-label="Workspace status">
        <div>
          <p className="eyebrow">Alpaca paper</p>
          <h1>Research Copilot</h1>
        </div>
        <div className="topbarActions">
          <button
            className="iconButton"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="iconButton" onClick={refreshBasics} title="Refresh status" aria-label="Refresh status">
            {busy === "refresh" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
        </div>
      </section>

      {message && (
        <div className="notice" role="status">
          <AlertTriangle size={18} />
          <span>{message}</span>
        </div>
      )}

      <section className="workspace">
        <aside className="leftRail">
          <section className="panel compactPanel statusCard">
            <details className="collapseBlock statusCollapse">
              <summary>
                <ShieldCheck size={16} />
                <span>System status</span>
                <ChevronDown className="summaryChevron" size={16} />
              </summary>
              <div className="collapseBody">
                <section className="statusGrid">
                  <StatusTile
                    icon={<ShieldCheck size={20} />}
                    label="Broker"
                    value={formatBrokerStatus(health)}
                    detail={health?.alpacaPaperOnly ? "Alpaca paper endpoint" : "Live URL blocked"}
                    tone={health?.alpacaConfigured && health.alpacaPaperOnly ? "good" : "warn"}
                  />
                  <StatusTile
                    icon={<ShieldCheck size={20} />}
                    label="Execution"
                    value={health?.paperTradingBlockedReasons?.length ? "Blocked" : "Paper only"}
                    detail={health?.paperTradingBlockedReasons?.[0] ?? "Manual confirmation required"}
                    tone={health?.paperTradingBlockedReasons?.length ? "warn" : "good"}
                  />
                  <StatusTile
                    icon={<Bot size={20} />}
                    label="AI Provider"
                    value={health?.aiConfigured ? formatAiProvider(health.aiProvider) : `${formatAiProvider(health?.aiProvider)} needs key`}
                    detail={health?.aiConfigured ? health.aiModel : undefined}
                    tone={health?.aiConfigured ? "good" : "warn"}
                  />
                  <StatusTile
                    icon={<Search size={20} />}
                    label="Context data"
                    value={formatContextProviderStatus(health)}
                    detail={health?.secUserAgentConfigured ? "SEC user agent set" : "Set SEC_USER_AGENT"}
                    tone={health?.alphaVantageConfigured || health?.secUserAgentConfigured ? "neutral" : "warn"}
                  />
                  <StatusTile
                    icon={<Settings size={20} />}
                    label="Data store"
                    value={health?.databaseConfigured ? "Postgres" : "Local JSON"}
                    detail={health ? formatDataStore(health.dataStore) : undefined}
                    tone="neutral"
                  />
                  <StatusTile
                    icon={<CircleDollarSign size={20} />}
                    label="Equity"
                    value={formatCurrency(account?.equity)}
                    tone="neutral"
                  />
                  <StatusTile
                    icon={<Activity size={20} />}
                    label="Positions"
                    value={positions ? String(positions.positions.length) : "Offline"}
                    tone={positions ? "neutral" : "warn"}
                  />
                </section>
              </div>
            </details>
          </section>

          <section className="panel sidebar">
            <div className="panelTitle">
              <LineChart size={18} />
              <h2>Watchlist</h2>
            </div>
            <form className="symbolForm" onSubmit={addSymbol}>
              <input
                value={newSymbol}
                onChange={(event) => setNewSymbol(event.target.value)}
                placeholder="Ticker"
                aria-label="Ticker"
              />
              <button className="iconButton primary" title="Add symbol" aria-label="Add symbol">
                <Search size={17} />
              </button>
            </form>
            <div className="watchlist">
              {watchlist.map((item) => (
                <button
                  className={`watchItem ${activeSignal?.symbol === item.symbol ? "selected" : ""}`}
                  key={item.symbol}
                  onClick={() => loadSymbol(item.symbol)}
                >
                  <span>{item.symbol}</span>
                  <Trash2
                    size={15}
                    role="button"
                    aria-label={`Remove ${item.symbol}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void saveWatchlist(watchlist.filter((candidate) => candidate.symbol !== item.symbol));
                    }}
                  />
                </button>
              ))}
            </div>
            <button className="wideButton" onClick={runScan} disabled={busy === "scan" || watchlist.length === 0}>
              {busy === "scan" ? <Loader2 className="spin" size={17} /> : <BarChart3 size={17} />}
              <span>Run scan</span>
            </button>
          </section>

        </aside>

        <section className="mainColumn">
          <WorkspaceTabs activeView={workspaceView} onChange={setWorkspaceView} />

          {workspaceView === "overview" && (
            <OverviewPanel
              activeSignal={activeSignal}
              account={account}
              positions={positions}
              proposals={algoProposals}
              monitor={positionMonitor}
              riskSettings={riskSettings}
              marketRegime={marketRegime}
              busy={busy}
              onRunScan={() => {
                setWorkspaceView("research");
                void runScan();
              }}
              onFindOpportunities={() => {
                setWorkspaceView("research");
                void findOpportunities(false);
              }}
              onBuildAlgo={() => {
                setWorkspaceView("algo");
                void generateAlgoProposals();
              }}
              onReviewOrder={() => setWorkspaceView("orders")}
              onOpenResearch={() => setWorkspaceView("research")}
            />
          )}

          {workspaceView === "research" && (
            <div className="tabSurface">
              <OpportunityFinderPanel
                scan={opportunityScan}
                busy={busy}
                open={opportunityOpen}
                onToggleOpen={() => setOpportunityOpen((current) => !current)}
                onFind={() => findOpportunities(false)}
                onRefresh={() => findOpportunities(true)}
                onAnalyze={analyzeOpportunity}
                onAddToWatchlist={addOpportunityToWatchlist}
                onRunScan={runOpportunityScan}
              />
              {signalPanel}
              <div className="researchDetailGrid">
                {detailPanel}
                {contextPanel}
              </div>
            </div>
          )}

          {workspaceView === "backtests" && (
            <div className="tabSurface">
              <BacktestsPanel
                form={backtestForm}
                result={backtestResult}
                busy={busy}
                onChange={setBacktestForm}
                onRun={runBacktest}
              />
            </div>
          )}

          {workspaceView === "algo" && (
            <div className="tabSurface">
              <AlgoCommandCenter
                activeSignal={activeSignal}
                proposals={algoProposals}
                busy={busy}
                filter={algoQueueFilter}
                search={algoSearch}
                onFilterChange={setAlgoQueueFilter}
                onSearchChange={setAlgoSearch}
                onGenerate={generateAlgoProposals}
                onExecute={executeAlgoProposal}
                onReject={rejectAlgoProposal}
                onDelete={deleteAlgoProposal}
              />
            </div>
          )}

          {workspaceView === "positions" && (
            <div className="tabSurface">
              <PositionMonitorPanel
                monitor={positionMonitor}
                busy={busy}
                onRefresh={refreshPositionMonitor}
                onClose={closeMonitoredPosition}
              />
            </div>
          )}

          {workspaceView === "orders" && (
            <div className="tabSurface twoColumnSurface">
              {orderPanel}
              {safetyPanel}
            </div>
          )}

          {workspaceView === "account" && (
            <div className="tabSurface accountSurface">
              {accountPanel}
              {journalPanel}
            </div>
          )}
        </section>
      </section>

      {reviewingOrder && (
        <div className="modalOverlay" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="Review paper order">
            <div className="panelTitle spaced">
              <div>
                <h2>Review paper bracket</h2>
                <p>{orderDraft.symbol || "No symbol"}</p>
              </div>
              <button className="iconButton" onClick={() => setReviewingOrder(false)} aria-label="Close review">
                x
              </button>
            </div>
            <dl className="reviewList">
              <div>
                <dt>Entry</dt>
                <dd>{orderDraft.side === "sell" ? "Short sell" : "Buy"} / {orderDraft.orderType === "limit" ? formatCurrency(orderDraft.limitPrice) : "Market"}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{orderDraft.quantity ? `${orderDraft.quantity} shares` : formatCurrency(orderDraft.notional)}</dd>
              </div>
              <div>
                <dt>Horizon</dt>
                <dd>{formatHorizon(orderDraft.horizon)}</dd>
              </div>
              <div>
                <dt>Holding</dt>
                <dd>{expectedHoldingPeriod(orderDraft.horizon)}</dd>
              </div>
              <div>
                <dt>TIF</dt>
                <dd>{orderDraft.timeInForce.toUpperCase()}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>{formatCurrency(orderReferencePrice)}</dd>
              </div>
              <div>
                <dt>Stop</dt>
                <dd>{formatCurrency(orderDraft.stopLossPrice)} {formatMovePct(orderTargetRealism.stopMovePct)}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{formatCurrency(orderDraft.takeProfitPrice)} {formatMovePct(orderTargetRealism.targetMovePct)}</dd>
              </div>
            </dl>
            {orderTargetRealism.message && (
              <p className={`realismNotice ${orderTargetRealism.severity}`}>
                {orderTargetRealism.message}
              </p>
            )}
            <button className="wideButton danger" onClick={submitPaperOrder} disabled={busy === "order" || !orderTargetRealism.ok}>
              {busy === "order" ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
              <span>Submit paper order</span>
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function WorkspaceTabs({
  activeView,
  onChange
}: {
  activeView: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
}) {
  const tabs: Array<{ view: WorkspaceView; label: string; icon: JSX.Element }> = [
    { view: "overview", label: "Overview", icon: <Activity size={16} /> },
    { view: "research", label: "Research", icon: <Target size={16} /> },
    { view: "backtests", label: "Backtests", icon: <BarChart3 size={16} /> },
    { view: "algo", label: "Algo", icon: <Bot size={16} /> },
    { view: "positions", label: "Positions", icon: <LineChart size={16} /> },
    { view: "orders", label: "Orders", icon: <ClipboardCheck size={16} /> },
    { view: "account", label: "Account", icon: <Settings size={16} /> }
  ];

  return (
    <nav className="workspaceTabs" aria-label="Workspace sections">
      {tabs.map((tab) => (
        <button
          key={tab.view}
          className={`workspaceTab ${activeView === tab.view ? "active" : ""}`}
          onClick={() => onChange(tab.view)}
          type="button"
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

function OverviewPanel({
  activeSignal,
  account,
  positions,
  proposals,
  monitor,
  riskSettings,
  marketRegime,
  busy,
  onRunScan,
  onFindOpportunities,
  onBuildAlgo,
  onReviewOrder,
  onOpenResearch
}: {
  activeSignal: SignalSnapshot | null;
  account: BrokerAccountSnapshot | null;
  positions: PositionsResponse | null;
  proposals: AlgoTradeProposal[];
  monitor: PositionMonitorSnapshot | null;
  riskSettings: RiskSettings | null;
  marketRegime: MarketRegimeSnapshot | null;
  busy: string | null;
  onRunScan: () => void;
  onFindOpportunities: () => void;
  onBuildAlgo: () => void;
  onReviewOrder: () => void;
  onOpenResearch: () => void;
}) {
  const queuedProposals = proposals.filter((proposal) => proposal.status === "queued").length;
  const exitsSuggested = monitor?.summary.exitsSuggested ?? 0;
  const openPositions = positions?.positions.length ?? 0;
  const selectedLabel = activeSignal ? `${activeSignal.symbol} - ${activeSignal.bias}, score ${activeSignal.score}` : "Select or scan a ticker";
  const regimeTone = marketRegime?.regime ?? "neutral";

  return (
    <section className="overviewStack" aria-label="Overview">
      <section className="commandPanel">
        <div className="commandCopy">
          <span>Today</span>
          <h2>{selectedLabel}</h2>
          <p>
            Start with a scan, inspect one setup, then approve only paper orders that pass the safety checks.
          </p>
        </div>
        <div className="commandActions">
          <button className="wideButton" onClick={onRunScan} disabled={busy === "scan"}>
            {busy === "scan" ? <Loader2 className="spin" size={17} /> : <BarChart3 size={17} />}
            <span>Run scan</span>
          </button>
          <button className="wideButton secondaryAction" onClick={onFindOpportunities} disabled={Boolean(busy)}>
            <Target size={17} />
            <span>Find opportunities</span>
          </button>
          <button className="wideButton secondaryAction" onClick={onBuildAlgo} disabled={!activeSignal || busy === "algo"}>
            {busy === "algo" ? <Loader2 className="spin" size={17} /> : <Bot size={17} />}
            <span>Build algo proposal</span>
          </button>
        </div>
      </section>

      <section className="overviewMetrics">
        <article className={regimeTone}>
          <span>Market regime</span>
          <strong>{marketRegime ? formatRegimeLabel(marketRegime.regime) : "Unavailable"}</strong>
        </article>
        <article>
          <span>Equity</span>
          <strong>{formatCurrency(account?.equity)}</strong>
        </article>
        <article>
          <span>Open positions</span>
          <strong>{openPositions}</strong>
        </article>
        <article className={queuedProposals ? "warn" : ""}>
          <span>Queued proposals</span>
          <strong>{queuedProposals}</strong>
        </article>
        <article className={exitsSuggested ? "danger" : ""}>
          <span>Exit alerts</span>
          <strong>{exitsSuggested}</strong>
        </article>
        <article className={riskSettings?.killSwitchEnabled ? "danger" : ""}>
          <span>Kill switch</span>
          <strong>{riskSettings?.killSwitchEnabled ? "On" : "Off"}</strong>
        </article>
      </section>

      <section className="overviewGrid">
        <article className="overviewCard">
          <div>
            <span>Broad market</span>
            <strong>{marketRegime ? `${marketRegime.score}/100` : "No regime data"}</strong>
          </div>
          <p>
            {marketRegime
              ? `${marketRegime.explanation} Suggested risk multiplier: ${marketRegime.riskAdjustmentMultiplier}x.`
              : "Market regime needs SPY and QQQ data from the server."}
          </p>
          {marketRegime?.warnings[0] && <small>{marketRegime.warnings[0]}</small>}
        </article>

        <article className="overviewCard">
          <div>
            <span>Selected setup</span>
            <strong>{activeSignal?.symbol ?? "No ticker selected"}</strong>
          </div>
          <p>{activeSignal ? `${activeSignal.trend} trend, ${activeSignal.bias} bias, ${activeSignal.riskReward ?? "--"}:1 R/R.` : "Use the watchlist or scanner to load a symbol."}</p>
          <button className="textButton secondary" onClick={onOpenResearch}>
            <Target size={16} />
            <span>Open research</span>
          </button>
        </article>

        <article className="overviewCard">
          <div>
            <span>Next order</span>
            <strong>{activeSignal ? activeSignal.symbol : "Waiting"}</strong>
          </div>
          <p>Review horizon, target distance, stop distance, and paper-only confirmations before placing anything.</p>
          <button className="textButton secondary" onClick={onReviewOrder}>
            <ClipboardCheck size={16} />
            <span>Review order form</span>
          </button>
        </article>
      </section>
    </section>
  );
}

function StatusTile({
  icon,
  label,
  value,
  detail,
  tone
}: {
  icon: JSX.Element;
  label: string;
  value: string;
  detail?: string;
  tone: string;
}) {
  return (
    <article className={`statusTile ${tone}`}>
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </article>
  );
}

function OpportunityFinderPanel({
  scan,
  busy,
  open,
  onToggleOpen,
  onFind,
  onRefresh,
  onAnalyze,
  onAddToWatchlist,
  onRunScan
}: {
  scan: OpportunityScan | null;
  busy: string | null;
  open: boolean;
  onToggleOpen: () => void;
  onFind: () => void;
  onRefresh: () => void;
  onAnalyze: (candidate: OpportunityCandidate) => void;
  onAddToWatchlist: (candidate: OpportunityCandidate) => void;
  onRunScan: (candidate: OpportunityCandidate) => void;
}) {
  const loading = busy === "opportunity" || busy === "opportunity-refresh";
  const candidates = scan?.candidates.slice(0, 8) ?? [];

  return (
    <section className={`panel opportunityPanel ${open ? "open" : "collapsed"}`} aria-label="Opportunity Finder">
      <div className="panelTitle spaced opportunityHeader">
        <div>
          <h2>Opportunity Finder</h2>
          <p>{open ? "Daily cached scan of liquid stocks and ETFs. No OpenAI credits used here." : getOpportunitySummary(scan)}</p>
        </div>
        <button
          className="iconButton opportunityToggle"
          onClick={onToggleOpen}
          aria-label={open ? "Collapse Opportunity Finder" : "Expand Opportunity Finder"}
          title={open ? "Collapse Opportunity Finder" : "Expand Opportunity Finder"}
        >
          <ChevronDown className="summaryChevron" size={18} />
        </button>
      </div>

      {open && (
        <>
          <div className="opportunityActions">
            <button className="textButton" onClick={onFind} disabled={loading}>
              {busy === "opportunity" ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
              <span>Find opportunities</span>
            </button>
            <button className="textButton secondary" onClick={onRefresh} disabled={loading}>
              {busy === "opportunity-refresh" ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              <span>Refresh today</span>
            </button>
          </div>

          {scan ? (
            <div className="opportunityMeta">
              <span>Last scanned {formatDateTime(scan.createdAt)}</span>
              <span>{scan.universe.length} symbols checked</span>
              {scan.skipped.length > 0 && <span>{scan.skipped.length} skipped</span>}
            </div>
          ) : (
            <div className="opportunityEmpty">Run discovery to get ranked tickers before adding them to your watchlist.</div>
          )}

          {candidates.length > 0 && (
            <div className="opportunityGrid">
              {candidates.map((candidate) => (
                <article className={`opportunityCard ${candidate.category}`} key={candidate.symbol}>
                  <div className="opportunityTopline">
                    <span>#{candidate.rank}</span>
                    <strong>{candidate.symbol}</strong>
                    <em>{formatOpportunityCategory(candidate.category)}</em>
                  </div>
                  <p>{candidate.reason}</p>
                  <div className="opportunityStats">
                    <span>Opp {candidate.opportunityScore}</span>
                    <span>Risk adj {candidate.riskAdjustedScore}</span>
                    {candidate.ranking && <span>{formatRankingAction(candidate.ranking.action)}</span>}
                    {candidate.ranking && <span>Model {candidate.ranking.adjustedScore}</span>}
                    <span>{formatCurrency(candidate.lastPrice)}</span>
                    <span>{candidate.riskReward ? `${candidate.riskReward}:1` : "-- R/R"}</span>
                    <span>{candidate.upsidePct ? `${formatPct(candidate.upsidePct)} room` : "-- room"}</span>
                  </div>
                  {candidate.ranking && (
                    <div className="rankingBreakdown" aria-label={`${candidate.symbol} ranking breakdown`}>
                      <span>Trend {candidate.ranking.components.trendScore}</span>
                      <span>Momentum {candidate.ranking.components.momentumScore}</span>
                      <span>R/R {candidate.ranking.components.riskRewardScore}</span>
                      <span>Volume {candidate.ranking.components.volumeScore}</span>
                      <span>RSI {candidate.ranking.components.rsiQualityScore}</span>
                    </div>
                  )}
                  {candidate.warnings[0] && <small>{candidate.warnings[0]}</small>}
                  <div className="candidateActions">
                    <button className="textButton" onClick={() => onAnalyze(candidate)} disabled={Boolean(busy)}>
                      <Target size={15} />
                      <span>Analyze</span>
                    </button>
                    <button className="textButton secondary" onClick={() => onAddToWatchlist(candidate)} disabled={Boolean(busy)}>
                      <Save size={15} />
                      <span>Add</span>
                    </button>
                    <button className="textButton ghost" onClick={() => onRunScan(candidate)} disabled={Boolean(busy)}>
                      {busy === `opportunity-scan-${candidate.symbol}` ? <Loader2 className="spin" size={15} /> : <BarChart3 size={15} />}
                      <span>Run scan</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BacktestsPanel({
  form,
  result,
  busy,
  onChange,
  onRun
}: {
  form: BacktestForm;
  result: BacktestResult | null;
  busy: string | null;
  onChange: (next: BacktestForm | ((current: BacktestForm) => BacktestForm)) => void;
  onRun: () => void;
}) {
  const update = (patch: Partial<BacktestForm>) => onChange((current) => ({ ...current, ...patch }));
  const toggleRegime = (regime: MarketRegimeLabel) => {
    onChange((current) => {
      const selected = current.marketRegimeFilter.includes(regime);
      return {
        ...current,
        marketRegimeFilter: selected
          ? current.marketRegimeFilter.filter((item) => item !== regime)
          : [...current.marketRegimeFilter, regime]
      };
    });
  };
  const latestCurve = result?.equityCurve.slice(-8) ?? [];
  const trades = result?.trades.slice(0, 12) ?? [];

  return (
    <section className="panel backtestPanel" aria-label="Backtests">
      <div className="panelTitle spaced">
        <div>
          <h2>Backtests</h2>
          <p>Long-only swing test using historical bars. Signals use only past data and enter on the next bar.</p>
        </div>
        <button className="textButton" onClick={onRun} disabled={busy === "backtest"}>
          {busy === "backtest" ? <Loader2 className="spin" size={17} /> : <BarChart3 size={17} />}
          <span>Run backtest</span>
        </button>
      </div>

      <div className="backtestForm">
        <label>
          <span>Symbols</span>
          <input value={form.symbols} onChange={(event) => update({ symbols: event.target.value })} />
        </label>
        <label>
          <span>Start</span>
          <input type="date" value={form.startDate} onChange={(event) => update({ startDate: event.target.value })} />
        </label>
        <label>
          <span>End</span>
          <input type="date" value={form.endDate} onChange={(event) => update({ endDate: event.target.value })} />
        </label>
        <label>
          <span>Holding days</span>
          <input type="number" min="1" max="60" value={form.holdingPeriodDays} onChange={(event) => update({ holdingPeriodDays: Number(event.target.value) })} />
        </label>
        <label>
          <span>Max positions</span>
          <input type="number" min="1" max="20" value={form.maxPositions} onChange={(event) => update({ maxPositions: Number(event.target.value) })} />
        </label>
        <label>
          <span>Min score</span>
          <input type="number" min="1" max="100" value={form.minScore} onChange={(event) => update({ minScore: Number(event.target.value) })} />
        </label>
        <fieldset className="regimeFilter">
          <legend>Allowed regimes</legend>
          {(["bullish", "neutral", "caution", "bearish"] as MarketRegimeLabel[]).map((regime) => (
            <label key={regime}>
              <input
                type="checkbox"
                checked={form.marketRegimeFilter.includes(regime)}
                onChange={() => toggleRegime(regime)}
              />
              <span>{formatRegimeLabel(regime)}</span>
            </label>
          ))}
          <small>{form.marketRegimeFilter.length ? "Only enter during selected regimes." : "No filter"}</small>
        </fieldset>
      </div>

      {!result ? (
        <EmptyState text="Run a backtest to compare the strategy against SPY." />
      ) : (
        <>
          <section className="backtestMetrics" aria-label="Backtest summary">
            <article>
              <span>Total return</span>
              <strong>{formatPctPoints(result.totalReturnPct)}</strong>
            </article>
            <article>
              <span>Annualized</span>
              <strong>{result.annualizedReturnPct === null ? "--" : formatPctPoints(result.annualizedReturnPct)}</strong>
            </article>
            <article>
              <span>Win rate</span>
              <strong>{formatPctPoints(result.winRate)}</strong>
            </article>
            <article>
              <span>Max drawdown</span>
              <strong>{formatPctPoints(result.maxDrawdownPct)}</strong>
            </article>
            <article>
              <span>Trades</span>
              <strong>{result.numberOfTrades}</strong>
            </article>
            <article>
              <span>SPY benchmark</span>
              <strong>{result.benchmarkReturnPct === null ? "--" : formatPctPoints(result.benchmarkReturnPct)}</strong>
            </article>
          </section>

          {result.warnings.length > 0 && (
            <div className="contextWarnings">
              {result.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}

          <div className="backtestTables">
            <section>
              <div className="sectionHeader">
                <h3>Equity Curve</h3>
                <span>Latest points</span>
              </div>
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Equity</th>
                      <th>SPY</th>
                      <th>Drawdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestCurve.map((point) => (
                      <tr key={point.date}>
                        <td>{point.date}</td>
                        <td>{formatCurrency(point.equity)}</td>
                        <td>{formatCurrency(point.benchmarkEquity)}</td>
                        <td>{formatPctPoints(point.drawdownPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <div className="sectionHeader">
                <h3>Trades</h3>
                <span>{result.trades.length} total</span>
              </div>
              {!trades.length ? (
                <EmptyState text="No trades met the filters." />
              ) : (
                <div className="tableWrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Entry</th>
                        <th>Exit</th>
                        <th>P/L</th>
                        <th>R</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((trade) => (
                        <tr key={trade.id}>
                          <td>{trade.symbol}</td>
                          <td>{trade.entryDate} @ {formatCurrency(trade.entryPrice)}</td>
                          <td>{trade.exitDate} @ {formatCurrency(trade.exitPrice)}</td>
                          <td>{formatCurrency(trade.pnl)}</td>
                          <td>{trade.rMultiple}</td>
                          <td>{trade.exitReason.replaceAll("_", " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function AlgoCommandCenter({
  activeSignal,
  proposals,
  busy,
  filter,
  search,
  onFilterChange,
  onSearchChange,
  onGenerate,
  onExecute,
  onReject,
  onDelete
}: {
  activeSignal: SignalSnapshot | null;
  proposals: AlgoTradeProposal[];
  busy: string | null;
  filter: AlgoQueueFilter;
  search: string;
  onFilterChange: (filter: AlgoQueueFilter) => void;
  onSearchChange: (search: string) => void;
  onGenerate: () => void;
  onExecute: (proposal: AlgoTradeProposal) => void;
  onReject: (proposal: AlgoTradeProposal) => void;
  onDelete: (proposal: AlgoTradeProposal) => void;
}) {
  const statusOrder: Record<AlgoTradeProposal["status"], number> = {
    queued: 0,
    blocked: 1,
    placed: 2,
    rejected: 3
  };
  const sorted = [...proposals].sort((left, right) => {
    const statusDelta = statusOrder[left.status] - statusOrder[right.status];
    if (statusDelta !== 0) return statusDelta;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  const activeProposals = sorted.filter((proposal) => proposal.status === "queued" || proposal.status === "blocked");
  const uniqueActiveProposals = getUniqueActiveProposals(activeProposals);
  const historyProposals = sorted.filter((proposal) => proposal.status === "placed" || proposal.status === "rejected");
  const selectedSymbol = activeSignal?.symbol;
  const filteredByView = filter === "active"
    ? uniqueActiveProposals
    : filter === "selected" && selectedSymbol
      ? [...uniqueActiveProposals, ...historyProposals].filter((proposal) => proposal.symbol === selectedSymbol)
      : filter === "history"
        ? historyProposals
        : [...uniqueActiveProposals, ...historyProposals];
  const normalizedSearch = search.trim().toLowerCase();
  const visible = normalizedSearch
    ? filteredByView.filter((proposal) => getProposalSearchText(proposal).includes(normalizedSearch))
    : filteredByView;
  const queuedCount = proposals.filter((proposal) => proposal.status === "queued").length;
  const placedCount = proposals.filter((proposal) => proposal.status === "placed").length;
  const blockedCount = proposals.filter((proposal) => proposal.status === "blocked").length;
  const duplicateCount = activeProposals.length - uniqueActiveProposals.length;
  const loading = busy === "algo";
  const filters: Array<{ value: AlgoQueueFilter; label: string; disabled?: boolean }> = [
    { value: "active", label: "Active" },
    { value: "selected", label: selectedSymbol ? selectedSymbol : "Selected", disabled: !selectedSymbol },
    { value: "all", label: "All" },
    { value: "history", label: "History" }
  ];

  return (
    <section className="panel algoPanel" aria-label="Algo Command Center">
      <div className="panelTitle spaced">
        <div>
          <h2>Algo Command Center</h2>
          <p>Bot-built trade proposals. You approve before any paper order is sent.</p>
        </div>
        <button className="textButton" onClick={onGenerate} disabled={!activeSignal || loading}>
          {loading ? <Loader2 className="spin" size={17} /> : <Bot size={17} />}
          <span>{activeSignal ? `Build ${activeSignal.symbol}` : "Select ticker"}</span>
        </button>
      </div>
      <div className="algoSummary" aria-label="Algo proposal summary">
        <span>{proposals.length} saved</span>
        <span>{queuedCount} queued</span>
        <span>{placedCount} placed</span>
        {blockedCount ? <span>{blockedCount} blocked</span> : <span>0 blocked</span>}
        {duplicateCount > 0 && <span>{duplicateCount} duplicate hidden</span>}
        <span>{visible.length} shown</span>
      </div>
      <div className="algoToolbar">
        <div className="segmentedControl" aria-label="Algo proposal view">
          {filters.map((item) => (
            <button
              key={item.value}
              className={filter === item.value ? "active" : ""}
              disabled={item.disabled}
              onClick={() => onFilterChange(item.value)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="searchControl">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search ticker or strategy"
            aria-label="Search algo proposals"
          />
        </label>
      </div>

      {!visible.length ? (
        <div className="algoEmpty">{proposals.length ? "No proposals match this view." : "Generate proposals from a selected ticker to create an approval queue."}</div>
      ) : (
        <div className="algoList">
          {visible.map((proposal) => (
            <article key={proposal.id} className={`algoCard ${proposal.status}`}>
              <div className="algoTopline">
                <div>
                  <strong>{proposal.symbol}</strong>
                  <span>{proposal.strategyTitle} - {proposal.direction}</span>
                </div>
                <em>{proposal.status}</em>
              </div>
              <p>{proposal.summary}</p>
              <div className="strategyStats">
                <span>Score {proposal.score}</span>
                <span>{proposal.executable ? `Executable ${formatHorizon(proposal.horizon ?? "intraday")} ${proposal.order ? "stock bracket" : "option entry"}` : "Research only"}</span>
                <span>{proposal.expectedHoldingPeriod ?? expectedHoldingPeriod(proposal.horizon ?? "intraday")}</span>
                {proposal.order && <span>TIF {proposal.order.timeInForce.toUpperCase()}</span>}
                {proposal.optionOrder && <span>TIF {proposal.optionOrder.timeInForce.toUpperCase()}</span>}
                {proposal.order && <span>{proposal.order.quantity} shares</span>}
                {proposal.optionOrder && <span>{proposal.optionOrder.contractSymbol}</span>}
                {proposal.optionOrder && <span>{proposal.optionOrder.quantity} contract</span>}
                {proposal.optionOrder?.limitPrice && <span>Limit {formatCurrency(proposal.optionOrder.limitPrice)}</span>}
                {proposal.order && <span>Stop {formatCurrency(proposal.order.stopLossPrice)} {formatMovePct(proposal.targetRealism?.stopMovePct ?? proposal.validation?.levelDistances?.stopMovePct)}</span>}
                {proposal.order && <span>Target {formatCurrency(proposal.order.takeProfitPrice)} {formatMovePct(proposal.targetRealism?.targetMovePct ?? proposal.validation?.levelDistances?.targetMovePct)}</span>}
              </div>
              {proposal.targetRealism?.message && <small>{proposal.targetRealism.message}</small>}
              {proposal.warnings[0] && <small>{proposal.warnings[0]}</small>}
              <div className="algoActions">
                <button
                  className="textButton"
                  onClick={() => onExecute(proposal)}
                  disabled={!proposal.executable || proposal.status !== "queued" || busy === `algo-execute-${proposal.id}`}
                >
                  {busy === `algo-execute-${proposal.id}` ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
                  <span>Approve + place</span>
                </button>
                <button
                  className="textButton ghost"
                  onClick={() => onReject(proposal)}
                  disabled={proposal.status !== "queued" || busy === `algo-reject-${proposal.id}`}
                >
                  <Trash2 size={16} />
                  <span>Reject</span>
                </button>
                <button
                  className="iconButton danger"
                  onClick={() => onDelete(proposal)}
                  disabled={busy === `algo-delete-${proposal.id}`}
                  title="Delete proposal"
                  aria-label={`Delete ${proposal.symbol} ${proposal.strategyTitle} proposal`}
                >
                  {busy === `algo-delete-${proposal.id}` ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function getUniqueActiveProposals(proposals: AlgoTradeProposal[]) {
  const byKey = new Map<string, AlgoTradeProposal>();
  for (const proposal of proposals) {
    const key = getProposalDedupeKey(proposal);
    const current = byKey.get(key);
    if (!current || proposal.updatedAt.localeCompare(current.updatedAt) > 0) {
      byKey.set(key, proposal);
    }
  }
  return [...byKey.values()];
}

function getProposalDedupeKey(proposal: AlgoTradeProposal) {
  return [
    proposal.symbol,
    proposal.strategyKind,
    proposal.direction,
    proposal.executionType,
    proposal.order?.side ?? "",
    proposal.optionOrder?.contractSymbol ?? ""
  ].join("|");
}

function getProposalSearchText(proposal: AlgoTradeProposal) {
  return [
    proposal.symbol,
    proposal.strategyTitle,
    proposal.strategyKind,
    proposal.direction,
    proposal.status,
    proposal.summary,
    proposal.optionOrder?.contractSymbol
  ].filter(Boolean).join(" ").toLowerCase();
}

function PositionMonitorPanel({
  monitor,
  busy,
  onRefresh,
  onClose
}: {
  monitor: PositionMonitorSnapshot | null;
  busy: string | null;
  onRefresh: () => void;
  onClose: (position: MonitoredPosition) => void;
}) {
  const positions = monitor?.positions.slice(0, 6) ?? [];

  return (
    <section className="panel monitorPanel" aria-label="Position Monitor">
      <div className="panelTitle spaced">
        <div>
          <h2>Position Monitor</h2>
          <p>Exit rules for paper positions. Option exits need explicit close approval.</p>
        </div>
        <button className="textButton secondary" onClick={onRefresh} disabled={busy === "position-monitor"}>
          {busy === "position-monitor" ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
          <span>Refresh monitor</span>
        </button>
      </div>

      {monitor && (
        <div className="monitorSummary">
          <span>{monitor.summary.totalPositions} positions</span>
          <span>{monitor.summary.exitsSuggested} exits</span>
          <span>{monitor.summary.watchCount} watch</span>
          <span>{formatCurrency(monitor.summary.totalUnrealizedPl)} open P/L</span>
          <span>Updated {formatDateTime(monitor.generatedAt)}</span>
        </div>
      )}

      {!positions.length ? (
        <div className="algoEmpty">No open Alpaca paper positions found.</div>
      ) : (
        <div className="monitorList">
          {positions.map((position) => (
            <article key={position.symbol} className={`monitorCard ${position.urgency}`}>
              <div className="algoTopline">
                <div>
                  <strong>{position.symbol}</strong>
                  <span>{position.side} {position.strategyKind ? `- ${formatStrategyKind(position.strategyKind)}` : ""}</span>
                </div>
                <em>{position.urgency}</em>
              </div>
              <p>{position.suggestedAction}</p>
              <div className="strategyStats">
                <span>{position.quantity ?? "--"} qty</span>
                <span>Avg {formatCurrency(position.avgEntryPrice)}</span>
                <span>Now {formatCurrency(position.currentPrice)}</span>
                <span>P/L {formatCurrency(position.unrealizedPl)}</span>
                {typeof position.unrealizedPlPct === "number" && <span>{formatPct(position.unrealizedPlPct)}</span>}
                {position.daysToExpiration !== undefined && <span>{position.daysToExpiration} DTE</span>}
                {position.stopLossPrice !== undefined && <span>Stop {formatCurrency(position.stopLossPrice)}</span>}
                {position.takeProfitPrice !== undefined && <span>Target {formatCurrency(position.takeProfitPrice)}</span>}
              </div>
              <small>{position.reasons[0]}</small>
              <div className="algoActions">
                <button
                  className={`textButton ${position.urgency === "exit" ? "danger" : "ghost"}`}
                  onClick={() => onClose(position)}
                  disabled={busy === `close-position-${position.symbol}`}
                >
                  {busy === `close-position-${position.symbol}` ? <Loader2 className="spin" size={16} /> : <AlertTriangle size={16} />}
                  <span>Close position</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function getOpportunitySummary(scan: OpportunityScan | null): string {
  if (!scan) return "Closed. Expand to find ranked tickers.";
  const top = scan.candidates[0];
  if (!top) return `Closed. Last scanned ${formatDateTime(scan.createdAt)}.`;
  return `Closed. ${scan.candidates.length} ideas from ${formatDateTime(scan.createdAt)}. Top: ${top.symbol} (${formatOpportunityCategory(top.category)}).`;
}

function SignalCard({
  signal,
  active,
  loading,
  onSelect
}: {
  signal: Pick<SignalSnapshot, "symbol" | "score" | "bias" | "trend" | "lastPrice" | "riskReward">;
  active: boolean;
  loading: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`signalCard ${active ? "selected" : ""}`} onClick={onSelect}>
      <span
        className="scoreRing"
        title="Setup score from 0-100. Higher means cleaner technical conditions, not an automatic buy."
        aria-label={`Setup score ${signal.score || "not available"} out of 100`}
      >
        {loading ? <Loader2 className="spin" size={16} /> : signal.score || "--"}
      </span>
      <span>
        <strong>{signal.symbol}</strong>
        <small>{signal.trend}</small>
      </span>
      <span className={`pill ${signal.bias}`}>{signal.bias}</span>
      <span>{formatCurrency(signal.lastPrice)}</span>
      <span>{signal.riskReward ? `${signal.riskReward}:1` : "--"}</span>
    </button>
  );
}

function BeginnerGuidance({ signal, plan }: { signal: SignalSnapshot; plan: TradePlan | null }) {
  const guidance = getBeginnerAction(signal, plan);

  return (
    <section className={`guidanceCard ${guidance.tone}`} aria-label="Plain English action summary">
      <div className="guidanceHeader">
        <HelpCircle size={18} />
        <span>Plain-English read</span>
        <strong>{guidance.label}</strong>
      </div>
      <p>{guidance.action}</p>
      <dl>
        <div>
          <dt>Why</dt>
          <dd>{guidance.why}</dd>
        </div>
        <div>
          <dt>Options</dt>
          <dd>{guidance.options}</dd>
        </div>
      </dl>
    </section>
  );
}

function QuantPlanCard({ plan, signal }: { plan: DeterministicTradePlan | null; signal: SignalSnapshot }) {
  if (!plan) {
    return (
      <section className="quantPlan loading" aria-label="Quantitative trade plan">
        <div className="quantPlanHeader">
          <Target size={18} />
          <div>
            <span>Quant plan</span>
            <strong>{signal.symbol}</strong>
          </div>
        </div>
        <p>Building deterministic entry, stop, target, sizing, and risk checks from the latest signal.</p>
      </section>
    );
  }

  const regime = plan.marketRegime ? `${formatRegimeLabel(plan.marketRegime.regime)} (${plan.marketRegime.score})` : "Unavailable";

  return (
    <section className={`quantPlan ${plan.action === "avoid" ? "danger" : plan.action === "watch" ? "warn" : "good"}`} aria-label="Quantitative trade plan">
      <div className="quantPlanHeader">
        <Target size={18} />
        <div>
          <span>Quant plan</span>
          <strong>{formatAction(plan.action)}</strong>
        </div>
        <small>{regime}</small>
      </div>
      <div className="quantPlanGrid">
        <div>
          <span>Entry zone</span>
          <strong>{formatPriceZone(plan.entryZone)}</strong>
        </div>
        <div>
          <span>Stop</span>
          <strong>{formatCurrency(plan.stopLoss)}</strong>
        </div>
        <div>
          <span>Target</span>
          <strong>{formatCurrency(plan.conservativeTarget)} / {formatCurrency(plan.aggressiveTarget)}</strong>
        </div>
        <div>
          <span>Risk/reward</span>
          <strong>{plan.riskReward ? `${plan.riskReward}:1` : "--"}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>{plan.positionSizeShares ?? "--"} sh</strong>
        </div>
        <div>
          <span>Max risk</span>
          <strong>{formatCurrency(plan.maxRiskDollars)}</strong>
        </div>
      </div>
      <p className="quantInvalidation">{plan.invalidationCondition}</p>
      <div className="quantPlanLists">
        <div>
          <span>Reasons</span>
          {plan.keyReasons.slice(0, 3).map((reason) => <p key={reason}>{reason}</p>)}
        </div>
        <div>
          <span>Risks</span>
          {[...plan.keyRisks, ...plan.warnings].slice(0, 3).map((risk) => <p key={risk}>{risk}</p>)}
        </div>
      </div>
    </section>
  );
}

function Sparkline({ bars }: { bars: SignalSnapshot["bars"] }) {
  const points = bars.slice(-80);
  if (points.length < 2) return <div className="sparkline emptyChart" />;
  const closes = points.map((bar) => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const path = closes
    .map((close, index) => {
      const x = (index / (closes.length - 1)) * 100;
      const y = 100 - ((close - min) / range) * 90 - 5;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Price sparkline">
      <path className="sparkArea" d={`${path} L 100 100 L 0 100 Z`} />
      <path className="sparkPath" d={path} />
    </svg>
  );
}

function MetricStrip({ signal }: { signal: SignalSnapshot }) {
  const metrics = [
    ["SMA 20", signal.sma20],
    ["SMA 50", signal.sma50],
    ["SMA 200", signal.sma200],
    ["RSI", signal.rsi14],
    ["ATR", signal.atr14],
    ["Vol", signal.volumeRatio],
    ["Stop", signal.suggestedStop],
    ["Target", signal.suggestedTarget]
  ];

  return (
    <div className="metricGrid">
      {metrics.map(([label, value]) => (
        <div key={label as string}>
          <span>{label}</span>
          <strong>{typeof value === "number" ? value : "--"}</strong>
        </div>
      ))}
    </div>
  );
}

function PaperOrderForm({
  activeSignal,
  orderDraft,
  setOrderDraft,
  targetRealism,
  onReview
}: {
  activeSignal: SignalSnapshot | null;
  orderDraft: PaperOrderRequest;
  setOrderDraft: (next: PaperOrderRequest | ((draft: PaperOrderRequest) => PaperOrderRequest)) => void;
  targetRealism: ReturnType<typeof checkDayOrderTargetRealism>;
  onReview: () => void;
}) {
  const update = (patch: Partial<PaperOrderRequest>) => {
    setOrderDraft((draft) => ({ ...draft, ...patch }));
  };

  return (
    <form className="orderForm">
      <label>
        <span>Symbol</span>
        <input value={orderDraft.symbol} onChange={(event) => update({ symbol: event.target.value.toUpperCase() })} />
      </label>
      <label>
        <span>Side</span>
        <select value={orderDraft.side} onChange={(event) => update({ side: event.target.value as "buy" | "sell" })}>
          <option value="buy">Buy / long</option>
          <option value="sell">Sell short</option>
        </select>
      </label>
      <label>
        <span>Horizon</span>
        <select
          value={orderDraft.horizon}
          onChange={(event) => {
            const horizon = event.target.value as TradeHorizon;
            update({
              horizon,
              timeInForce: selectDefaultTimeInForce({ horizon, assetClass: "stock" })
            });
          }}
        >
          <option value="intraday">Intraday</option>
          <option value="swing">Swing</option>
          <option value="position">Position</option>
        </select>
      </label>
      <label>
        <span>Order</span>
        <select value={orderDraft.orderType} onChange={(event) => update({ orderType: event.target.value as "market" | "limit" })}>
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
      </label>
      {orderDraft.orderType === "limit" && (
        <label>
          <span>Limit</span>
          <input type="number" step="0.01" value={orderDraft.limitPrice ?? ""} onChange={(event) => updateNumber(update, "limitPrice", event.target.value)} />
        </label>
      )}
      <label>
        <span>Shares</span>
        <input type="number" step="1" min="0" value={orderDraft.quantity ?? ""} onChange={(event) => updateNumber(update, "quantity", event.target.value)} />
      </label>
      <label>
        <span>Stop</span>
        <input type="number" step="0.01" value={orderDraft.stopLossPrice || ""} onChange={(event) => updateNumber(update, "stopLossPrice", event.target.value)} />
      </label>
      <label>
        <span>Target</span>
        <input type="number" step="0.01" value={orderDraft.takeProfitPrice || ""} onChange={(event) => updateNumber(update, "takeProfitPrice", event.target.value)} />
      </label>
      <label>
        <span>TIF</span>
        <select value={orderDraft.timeInForce} onChange={(event) => update({ timeInForce: event.target.value as "day" | "gtc" })}>
          <option value="day">Day</option>
          <option value="gtc">GTC</option>
        </select>
      </label>
      <div className={`orderPreview ${targetRealism.severity}`}>
        <span>{formatHorizon(orderDraft.horizon)} - {expectedHoldingPeriod(orderDraft.horizon)}</span>
        <strong>
          Target {formatDistancePct(targetRealism.targetDistancePct)} / Stop {formatDistancePct(targetRealism.stopDistancePct)}
        </strong>
        {targetRealism.message && <small>{targetRealism.message}</small>}
      </div>
      <div className="checkboxStack">
        <label>
          <input type="checkbox" checked={orderDraft.earningsChecked} onChange={(event) => update({ earningsChecked: event.target.checked })} />
          <span>Earnings checked</span>
        </label>
        <label>
          <input type="checkbox" checked={orderDraft.confirmedPaperOnly} onChange={(event) => update({ confirmedPaperOnly: event.target.checked })} />
          <span>Paper only</span>
        </label>
        <label>
          <input type="checkbox" checked={orderDraft.acceptedRisk} onChange={(event) => update({ acceptedRisk: event.target.checked })} />
          <span>Risk accepted</span>
        </label>
      </div>
      <button
        type="button"
        className="wideButton"
        disabled={!activeSignal || !orderDraft.symbol}
        onClick={onReview}
      >
        <Save size={17} />
        <span>Review order</span>
      </button>
    </form>
  );
}

function DecisionCenter({ analysis }: { analysis: AnalysisRun }) {
  const hardBlockers = analysis.safetyBlockers.filter((blocker) => blocker.severity === "blocker");
  return (
    <article className="decisionCenter">
      <div className={`verdictCard ${hardBlockers.length ? "danger" : analysis.managerVerdict.bias}`}>
        <div>
          <span>Manager verdict</span>
          <strong>{formatAction(analysis.managerVerdict.action)}</strong>
        </div>
        <p>{analysis.managerVerdict.summary}</p>
        <small>{analysis.managerVerdict.bias} - {analysis.managerVerdict.confidence} confidence</small>
      </div>

      <SafetyBlockerList blockers={analysis.safetyBlockers} />

      <StrategyCandidateList candidates={analysis.strategyCandidates ?? []} />

      <div className="scenarioGrid">
        {analysis.managerVerdict.scenarios.map((scenario) => (
          <article key={scenario.label}>
            <span>{scenario.label}</span>
            <p>{scenario.summary}</p>
            <small>{scenario.trigger}</small>
          </article>
        ))}
      </div>

      <div className="specialistGrid">
        {analysis.specialistReports.map((report) => (
          <article key={report.kind} className={`specialistCard ${report.bias}`}>
            <div>
              <strong>{report.title}</strong>
              <span>{report.score}</span>
            </div>
            <p>{report.summary}</p>
            <small>{report.evidence.slice(0, 2).join(" ")}</small>
            {report.warnings[0] && <em>{report.warnings[0]}</em>}
          </article>
        ))}
      </div>

      <ListBlock title="Entry Requirements" items={analysis.managerVerdict.entryRequirements} />
      {analysis.managerVerdict.dissent.length > 0 && <ListBlock title="Disagreement" items={analysis.managerVerdict.dissent} />}
      <p className="invalidation">{analysis.managerVerdict.invalidation}</p>
    </article>
  );
}

function StrategyCandidateList({ candidates }: { candidates: AnalysisRun["strategyCandidates"] }) {
  if (!candidates.length) return null;

  return (
    <section className="strategySection" aria-label="Position ideas">
      <div className="sectionHeader">
        <h3>Position ideas</h3>
        <span>Research, compare, then choose manually</span>
      </div>
      <div className="strategyGrid">
        {candidates.slice(0, 6).map((candidate) => (
          <article key={candidate.kind} className={`strategyCard ${candidate.suitability}`}>
            <div className="strategyTopline">
              <strong>{candidate.title}</strong>
              <span>{candidate.score}</span>
            </div>
            <div className="strategyMeta">
              <span>{candidate.direction}</span>
              <span>{candidate.suitability}</span>
            </div>
            <p>{candidate.summary}</p>
            {candidate.representativeContract && <small>{candidate.representativeContract}</small>}
            <div className="strategyStats">
              {typeof candidate.netDebit === "number" && <span>Debit {formatCurrency(candidate.netDebit)}</span>}
              {typeof candidate.netCredit === "number" && <span>Credit {formatCurrency(candidate.netCredit)}</span>}
              {typeof candidate.breakeven === "number" && <span>BE {formatCurrency(candidate.breakeven)}</span>}
              {typeof candidate.estimatedMaxLoss === "number" && <span>Max loss {formatCurrency(candidate.estimatedMaxLoss)}</span>}
              {typeof candidate.estimatedMaxGain === "number" && <span>Max gain {formatCurrency(candidate.estimatedMaxGain)}</span>}
              {typeof candidate.probabilityOfProfit === "number" && <span>POP {formatPct(candidate.probabilityOfProfit)}</span>}
            </div>
            {candidate.legs && candidate.legs.length > 0 && (
              <small>{candidate.legs.join(" / ")}</small>
            )}
            <ul>
              {candidate.riskNotes.slice(0, 2).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            {candidate.warnings[0] && <em>{candidate.warnings[0]}</em>}
          </article>
        ))}
      </div>
    </section>
  );
}

function SafetyBlockerList({ blockers }: { blockers: AnalysisRun["safetyBlockers"] }) {
  if (!blockers.length) return <div className="safetyList clear">No deterministic safety blockers found.</div>;

  return (
    <div className="safetyList">
      {blockers.map((blocker) => (
        <p key={`${blocker.code}-${blocker.message}`} className={blocker.severity}>
          <AlertTriangle size={15} />
          <span>{blocker.message}</span>
        </p>
      ))}
    </div>
  );
}

function SafetyControls({
  riskSettings,
  onCancelOrders,
  onFlattenPositions,
  busy
}: {
  riskSettings: RiskSettings | null;
  onCancelOrders: () => void;
  onFlattenPositions: () => void;
  busy: string | null;
}) {
  if (!riskSettings) return <EmptyState text="Risk settings unavailable" />;

  return (
    <div className="safetyControls">
      <div className="metricGrid">
        <div>
          <span>Kill switch</span>
          <strong>{riskSettings.killSwitchEnabled ? "On" : "Off"}</strong>
        </div>
        <div>
          <span>Max risk</span>
          <strong>{formatPct(riskSettings.maxRiskPerTradePct)}</strong>
        </div>
        <div>
          <span>Max position</span>
          <strong>{formatPct(riskSettings.maxPositionPct)}</strong>
        </div>
        <div>
          <span>Min R/R</span>
          <strong>{riskSettings.minRiskReward}:1</strong>
        </div>
      </div>
      <button className="wideButton danger" onClick={onCancelOrders} disabled={busy === "cancel-orders"}>
        {busy === "cancel-orders" ? <Loader2 className="spin" size={17} /> : <AlertTriangle size={17} />}
        <span>Cancel open paper orders</span>
      </button>
      <button className="wideButton danger" onClick={onFlattenPositions} disabled={busy === "flatten-positions"}>
        {busy === "flatten-positions" ? <Loader2 className="spin" size={17} /> : <AlertTriangle size={17} />}
        <span>Flatten paper positions</span>
      </button>
    </div>
  );
}

function TradePlanView({
  plan,
  signal,
  savedPlan,
  onJournal,
  busy
}: {
  plan: TradePlan;
  signal: SignalSnapshot | null;
  savedPlan?: SavedTradePlan;
  onJournal: (status: "watching" | "skipped") => void;
  busy: boolean;
}) {
  const guidance = signal ? getBeginnerAction(signal, plan) : null;

  return (
    <article className="tradePlan">
      {guidance && (
        <div className={`quickDecision ${guidance.tone}`}>
          <strong>{guidance.label}</strong>
          <span>{guidance.action}</span>
        </div>
      )}
      <div className="planActions">
        <span className="actionBadge">{formatAction(plan.action)}</span>
        <button className="textButton secondary" onClick={() => onJournal("watching")} disabled={!savedPlan || busy}>
          <ClipboardCheck size={16} />
          <span>Watch in journal</span>
        </button>
        <button className="textButton ghost" onClick={() => onJournal("skipped")} disabled={!savedPlan || busy}>
          <Trash2 size={16} />
          <span>Skip</span>
        </button>
      </div>
      <p className={`pill ${plan.bias}`}>{plan.bias} - {plan.confidence}</p>
      {plan.beginnerSummary && <p className="beginnerSummary">{plan.beginnerSummary}</p>}
      <p>{plan.summary}</p>
      <ListBlock title="Before Entry" items={plan.entryRequirements} />
      <ListBlock title="Thesis" items={plan.thesis} />
      <ListBlock title="Risk" items={plan.riskNotes} />
      <ListBlock title="Do Not Trade If" items={plan.doNotTradeIf} />
      <ListBlock title="Options Notes" items={plan.optionsNotes} />
      <ListBlock title="Checklist" items={plan.actionChecklist} />
      <p className="invalidation">{plan.invalidation}</p>
    </article>
  );
}

function ContextPanel({ context }: { context?: TradeContext }) {
  if (!context) {
    return <div className="contextPanel emptyContext">Generate an AI plan to attach earnings, news, filings, and fundamentals.</div>;
  }

  const providerText = [
    `Alpha Vantage: ${context.providers.alphaVantage}`,
    `SEC: ${context.providers.sec}`
  ].join(" / ");

  return (
    <section className="contextPanel" aria-label="Context used by AI">
      <div className="contextHeader">
        <strong>Context used</strong>
        <span>{providerText}</span>
      </div>
      <div className="contextFacts">
        <div>
          <span>Earnings</span>
          <strong>{context.earnings?.nextEarningsDate ?? "--"}</strong>
        </div>
        <div>
          <span>Sector</span>
          <strong>{context.fundamentals?.sector ?? "--"}</strong>
        </div>
        <div>
          <span>News</span>
          <strong>{context.news.length}</strong>
        </div>
        <div>
          <span>Filings</span>
          <strong>{context.recentFilings.length}</strong>
        </div>
      </div>
      {context.news.length > 0 && (
        <div className="headlineList">
          {context.news.slice(0, 3).map((item) => (
            <p key={`${item.title}-${item.publishedAt}`}>{item.title}</p>
          ))}
        </div>
      )}
      {context.contextWarnings.length > 0 && (
        <div className="contextWarnings">
          {context.contextWarnings.slice(0, 2).map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function JournalAnalyticsSummary({ analytics }: { analytics: JournalAnalytics | null }) {
  if (!analytics) return <EmptyState text="Journal analytics unavailable" />;

  return (
    <section className="journalAnalytics" aria-label="Journal analytics">
      <div>
        <span>Total paper</span>
        <strong>{analytics.totalPaperTrades}</strong>
      </div>
      <div>
        <span>Win rate</span>
        <strong>{formatPctPoints(analytics.winRate)}</strong>
      </div>
      <div>
        <span>Average R</span>
        <strong>{analytics.averageR === null ? "--" : analytics.averageR}</strong>
      </div>
      <div>
        <span>Total P/L</span>
        <strong>{formatCurrency(analytics.totalPnl)}</strong>
      </div>
      <div>
        <span>Open</span>
        <strong>{analytics.openPaperTrades}</strong>
      </div>
      <div>
        <span>Skipped</span>
        <strong>{analytics.skippedTrades}</strong>
      </div>
      <div>
        <span>Follow plan</span>
        <strong>{analytics.followPlanRate === null ? "--" : formatPctPoints(analytics.followPlanRate)}</strong>
      </div>
      <div>
        <span>Deviations</span>
        <strong>{analytics.planDeviationTrades}</strong>
      </div>
      {(analytics.bestTrade || analytics.worstTrade || analytics.mostCommonSkippedReason || analytics.mostCommonExitReason) && (
        <div className="journalInsight">
          {analytics.bestTrade && <p>Best: {analytics.bestTrade.symbol} {formatCurrency(analytics.bestTrade.pnl)}</p>}
          {analytics.worstTrade && <p>Worst: {analytics.worstTrade.symbol} {formatCurrency(analytics.worstTrade.pnl)}</p>}
          {analytics.mostCommonExitReason && <p>Common exit: {formatExitReason(analytics.mostCommonExitReason)}</p>}
          {analytics.mostCommonSkippedReason && <p>Common skip: {analytics.mostCommonSkippedReason}</p>}
        </div>
      )}
    </section>
  );
}

function JournalList({
  journal,
  busy,
  onDelete
}: {
  journal: TradeJournalEntry[];
  busy: string | null;
  onDelete: (entry: TradeJournalEntry) => void;
}) {
  if (!journal.length) return <EmptyState text="No journal entries yet" />;

  return (
    <div className="journalList">
      {journal.slice(0, 6).map((entry) => (
        <article key={entry.id}>
          <div className="journalTopline">
            <strong>{entry.symbol}</strong>
            <span>{entry.status.replace("_", " ")}</span>
            <button
              className="iconButton danger"
              onClick={() => onDelete(entry)}
              disabled={busy === `journal-delete-${entry.id}`}
              title="Delete journal entry"
              aria-label={`Delete ${entry.symbol} journal entry`}
            >
              {busy === `journal-delete-${entry.id}` ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
            </button>
          </div>
          <p>{formatAction(entry.action)} - {entry.notes || "No notes"}</p>
          {(entry.sourceType || typeof entry.followedPlan === "boolean") && (
            <small>
              {[formatJournalSource(entry), typeof entry.followedPlan === "boolean" ? (entry.followedPlan ? "Followed plan" : "Plan deviation") : null]
                .filter(Boolean)
                .join(" - ")}
            </small>
          )}
          <small>{formatDateTime(entry.createdAt)}</small>
        </article>
      ))}
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items?: string[] }) {
  const safeItems = Array.isArray(items) ? items.filter((item) => typeof item === "string" && item.trim().length > 0) : [];
  if (!safeItems.length) return null;

  return (
    <div className="listBlock">
      <h3>{title}</h3>
      <ul>
        {safeItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function OptionsTable({ options }: { options: OptionIdea[] }) {
  const rows = options.slice(0, 12);
  if (!rows.length) return <EmptyState text="No option contracts loaded" />;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Type</th>
            <th>Exp</th>
            <th>Strike</th>
            <th>IV</th>
            <th>Delta</th>
            <th>POP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((option) => (
            <tr key={option.symbol}>
              <td>{option.symbol}</td>
              <td>{option.type}</td>
              <td>{option.expirationDate}</td>
              <td>{formatCurrency(option.strikePrice)}</td>
              <td>{formatOptionalPct(option.impliedVolatility)}</td>
              <td>{formatNumber(option.delta)}</td>
              <td>{formatOptionalPct(option.probabilityOfProfit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountPanel({ account, positions }: { account: BrokerAccountSnapshot | null; positions: PositionsResponse | null }) {
  if (!account && !positions) return <EmptyState text="Alpaca paper account offline" />;

  return (
    <div className="accountList">
      <div>
        <span>Cash</span>
        <strong>{formatCurrency(account?.cash)}</strong>
      </div>
      <div>
        <span>Buying power</span>
        <strong>{formatCurrency(account?.buyingPower)}</strong>
      </div>
      <div>
        <span>Open positions</span>
        <strong>{positions?.positions.length ?? 0}</strong>
      </div>
      <div>
        <span>Recent orders</span>
        <strong>{positions?.orders.length ?? 0}</strong>
      </div>
    </div>
  );
}

function getBeginnerAction(signal: SignalSnapshot, plan?: TradePlan | null): BeginnerAction {
  const riskReward = signal.riskReward ?? 0;
  const isGoodLongCandidate =
    signal.bias === "bullish" &&
    signal.trend === "uptrend" &&
    signal.score >= 70 &&
    riskReward >= 1.5;
  const isBearish = signal.bias === "bearish" || signal.trend === "downtrend";
  const isWeakReward = riskReward > 0 && riskReward < 1.5;

  if (isGoodLongCandidate) {
    return {
      label: "Paper long candidate",
      tone: "good",
      action: "This may be worth a small paper buy only after you check earnings/news and accept the stop/target risk.",
      why: `Trend is up, score is ${signal.score}, and risk/reward is about ${riskReward}:1.`,
      options: "For beginners, avoid options until the stock setup is clear and you understand max loss."
    };
  }

  if (isBearish) {
    return {
      label: "Avoid buying for now",
      tone: "danger",
      action: "This is not a good long/buy setup yet. If you do not already own it, waiting is the cleaner move.",
      why: `The trend is ${signal.trend} and the current bias is ${signal.bias}. A high risk/reward number can still be misleading when the trend is down.`,
      options: "Bearish options may exist, but this app is analyze-only for options and does not place options trades."
    };
  }

  if (isWeakReward) {
    return {
      label: "Watch, do not chase",
      tone: "warn",
      action: "The setup is not attractive enough for a conservative paper buy right now. Wait for a better entry or tighter stop.",
      why: `Risk/reward is only about ${riskReward}:1, below the 1.5:1 conservative minimum.`,
      options: "Options are higher risk here because the stock setup is not clean enough yet."
    };
  }

  if (plan?.confidence === "high" && plan.bias === "bullish") {
    return {
      label: "Review carefully",
      tone: "neutral",
      action: "The AI plan is constructive, but use the checklist before any paper order.",
      why: "The plan has higher confidence, but paper trading still needs a stop, target, and event check.",
      options: "Use options only as research unless you deliberately add options-trading rules later."
    };
  }

  return {
    label: "Watchlist only",
    tone: "neutral",
    action: "No clear beginner-friendly trade. Keep it on watch and compare it with stronger tickers.",
    why: `Current bias is ${signal.bias}, trend is ${signal.trend}, and score is ${signal.score}.`,
    options: "Skip options for now unless the stock setup becomes clearer."
  };
}

function EmptyState({ text }: { text: string }) {
  return <div className="emptyState">{text}</div>;
}

function watchlistPreview(watchlist: WatchlistItem[]) {
  return watchlist.map((item) => ({
    symbol: item.symbol,
    score: 0,
    bias: "caution" as const,
    trend: "insufficient_data" as const,
    lastPrice: null,
    riskReward: null
  }));
}

function isFullSignal(signal: Pick<SignalSnapshot, "bars"> | unknown): signal is SignalSnapshot {
  return Boolean(signal && typeof signal === "object" && "bars" in signal && Array.isArray((signal as SignalSnapshot).bars));
}

function updateNumber(
  update: (patch: Partial<PaperOrderRequest>) => void,
  key: keyof PaperOrderRequest,
  value: string
) {
  update({ [key]: value === "" ? undefined : Number(value) } as Partial<PaperOrderRequest>);
}

function orderMatchesActivePlan(order: PaperOrderRequest, signal: SignalSnapshot, quantPlan: DeterministicTradePlan | null): boolean {
  const plannedStop = quantPlan?.stopLoss ?? signal.suggestedStop;
  const plannedTarget = quantPlan?.conservativeTarget ?? signal.suggestedTarget;
  if (plannedStop === null || plannedTarget === null) return false;
  return pricesMatch(order.stopLossPrice, plannedStop) && pricesMatch(order.takeProfitPrice, plannedTarget);
}

function pricesMatch(left?: number | null, right?: number | null): boolean {
  if (typeof left !== "number" || typeof right !== "number") return false;
  return Math.abs(left - right) < 0.01;
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || body?.errors?.join(" ") || response.statusText);
  }

  return (await response.json()) as T;
}

function formatCurrency(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 100 ? 0 : 2
  }).format(value);
}

function formatPriceZone(zone: { low: number | null; high: number | null }): string {
  if (zone.low === null || zone.high === null) return "--";
  if (zone.low === zone.high) return formatCurrency(zone.low);
  return `${formatCurrency(zone.low)} - ${formatCurrency(zone.high)}`;
}

function formatPct(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

function formatPctPoints(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function formatRegimeLabel(value: MarketRegimeSnapshot["regime"]): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMovePct(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const rounded = Math.round(value * 10) / 10;
  return `(${rounded > 0 ? "+" : ""}${rounded}%)`;
}

function formatDistancePct(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function formatOptionalPct(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? formatPct(value) : "--";
}

function formatNumber(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "--";
}

function formatAiProvider(provider?: HealthStatus["aiProvider"]): string {
  return provider === "anthropic" ? "Claude" : "OpenAI";
}

function formatBrokerStatus(health: HealthStatus | null): string {
  if (!health) return "Checking";
  if (!health.alpacaPaperOnly) return "Blocked";
  return health.alpacaConfigured ? "Paper ready" : "Needs keys";
}

function formatContextProviderStatus(health: HealthStatus | null): string {
  if (!health) return "Checking";
  if (health.alphaVantageConfigured && health.secUserAgentConfigured) return "Full";
  if (health.alphaVantageConfigured || health.secUserAgentConfigured) return "Partial";
  return "Limited";
}

function formatDataStore(value: string): string {
  if (value === "postgres") return "Server database";
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts.slice(-2).join("/");
}

function formatOpportunityCategory(category: OpportunityCandidate["category"]): string {
  const labels: Record<OpportunityCandidate["category"], string> = {
    bullish_long: "Bullish long",
    bearish_short: "Bearish short",
    bullish_options: "Bullish options",
    bearish_options: "Bearish options",
    neutral_income: "Neutral income",
    watch_only: "Watch only"
  };
  return labels[category];
}

function formatRankingAction(action: NonNullable<OpportunityCandidate["ranking"]>["action"]): string {
  const labels: Record<NonNullable<OpportunityCandidate["ranking"]>["action"], string> = {
    buy: "Buy setup",
    watch: "Watch",
    avoid: "Avoid",
    hold: "Hold"
  };
  return labels[action];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAction(action?: TradeAction): string {
  switch (action) {
    case "paper_long_candidate":
      return "Paper long candidate";
    case "paper_short_candidate":
      return "Paper short candidate";
    case "options_research_only":
      return "Options research only";
    case "avoid":
      return "Avoid";
    case "watch":
    default:
      return "Watch";
  }
}

function formatJournalSource(entry: TradeJournalEntry): string | null {
  if (!entry.sourceType) return entry.planId ? `Plan ${entry.planId}` : null;
  const labels: Record<NonNullable<TradeJournalEntry["sourceType"]>, string> = {
    manual: "Manual",
    ai_plan: "AI plan",
    quant_plan: "Quant plan",
    algo_proposal: "Algo proposal",
    paper_order: "Paper order"
  };
  return entry.sourceId ? `${labels[entry.sourceType]} ${entry.sourceId}` : labels[entry.sourceType];
}

function formatExitReason(reason: NonNullable<TradeJournalEntry["exitReason"]>): string {
  const labels: Record<NonNullable<TradeJournalEntry["exitReason"]>, string> = {
    target: "Target",
    stop: "Stop",
    manual: "Manual",
    time_exit: "Time exit",
    score_drop: "Score drop",
    other: "Other"
  };
  return labels[reason];
}

function formatStrategyKind(kind: AlgoTradeProposal["strategyKind"]): string {
  return kind.replaceAll("_", " ");
}

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem("stocks-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Ignore storage errors and fall back to system preference.
  }
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}
