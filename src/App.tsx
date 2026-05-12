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
  AnalysisRun,
  BrokerAccountSnapshot,
  EnrichedTradePlanResponse,
  HealthStatus,
  OpportunityCandidate,
  OpportunityScan,
  OptionIdea,
  PaperOrderRequest,
  RiskSettings,
  SavedTradePlan,
  SignalSnapshot,
  TradeAction,
  TradeContext,
  TradeJournalEntry,
  TradePlan,
  WatchlistItem
} from "./shared/types";

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

const emptyOrder: PaperOrderRequest = {
  symbol: "",
  orderType: "market",
  quantity: 1,
  stopLossPrice: 0,
  takeProfitPrice: 0,
  timeInForce: "day",
  earningsChecked: false,
  confirmedPaperOnly: false,
  acceptedRisk: false
};

export function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [newSymbol, setNewSymbol] = useState("");
  const [snapshots, setSnapshots] = useState<SignalSnapshot[]>([]);
  const [activeSignal, setActiveSignal] = useState<SignalSnapshot | null>(null);
  const [analysisRuns, setAnalysisRuns] = useState<Record<string, AnalysisRun>>({});
  const [tradePlans, setTradePlans] = useState<Record<string, SavedTradePlan>>({});
  const [journal, setJournal] = useState<TradeJournalEntry[]>([]);
  const [opportunityScan, setOpportunityScan] = useState<OpportunityScan | null>(null);
  const [options, setOptions] = useState<OptionIdea[]>([]);
  const [account, setAccount] = useState<BrokerAccountSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionsResponse | null>(null);
  const [riskSettings, setRiskSettings] = useState<RiskSettings | null>(null);
  const [orderDraft, setOrderDraft] = useState<PaperOrderRequest>(emptyOrder);
  const [reviewingOrder, setReviewingOrder] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  const [analysisView, setAnalysisView] = useState<AnalysisView>("decision");
  const [opportunityOpen, setOpportunityOpen] = useState(true);

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
    setOrderDraft((draft) => ({
      ...draft,
      symbol: activeSignal.symbol,
      stopLossPrice: activeSignal.suggestedStop ?? draft.stopLossPrice,
      takeProfitPrice: activeSignal.suggestedTarget ?? draft.takeProfitPrice
    }));
    void loadOptions(activeSignal.symbol);
    void loadAnalysisHistory(activeSignal.symbol);
  }, [activeSignal]);

  const sortedSnapshots = useMemo(() => {
    return [...snapshots].sort((left, right) => right.score - left.score);
  }, [snapshots]);
  const activePlanRecord = activeSignal ? tradePlans[activeSignal.symbol] : undefined;
  const activeTradePlan = activePlanRecord?.plan ?? null;
  const activeAnalysis = activeSignal ? analysisRuns[activeSignal.symbol] : null;

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
      await Promise.all([loadAccount(), loadPositions(), loadSavedPlans(), loadJournal(), loadRiskSettings()]);
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
      setTradePlans(await api<Record<string, SavedTradePlan>>("/api/trade-plans"));
    } catch {
      setTradePlans({});
    }
  }

  async function loadJournal() {
    try {
      setJournal(await api<TradeJournalEntry[]>("/api/journal"));
    } catch {
      setJournal([]);
    }
  }

  async function loadRiskSettings() {
    try {
      setRiskSettings(await api<RiskSettings>("/api/settings/risk"));
    } catch {
      setRiskSettings(null);
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
    try {
      const result = await api<{ ideas: OptionIdea[] }>(`/api/options/${symbol}`);
      setOptions(result.ideas);
    } catch {
      setOptions([]);
    }
  }

  async function loadAnalysisHistory(symbol: string) {
    try {
      const runs = await api<AnalysisRun[]>(`/api/analysis-runs/${symbol}`);
      if (runs[0]) {
        setAnalysisRuns((current) => ({ ...current, [symbol]: runs[0] }));
      }
    } catch {
      // Analysis runs are an enhancement; missing history should not block symbol review.
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
      setAnalysisView("decision");
      setMessage("Decision Center analysis saved.");
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
      await loadPositions();
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
      await Promise.all([loadAccount(), loadPositions()]);
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
      await api("/api/alpaca/paper-orders", {
        method: "POST",
        body: JSON.stringify(orderDraft)
      });
      setReviewingOrder(false);
      setMessage("Paper bracket order submitted.");
      await Promise.all([loadAccount(), loadPositions()]);
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

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
                    value={health?.alpacaConfigured ? "Connected" : "Needs keys"}
                    tone={health?.alpacaConfigured ? "good" : "warn"}
                  />
                  <StatusTile
                    icon={<Bot size={20} />}
                    label="AI Provider"
                    value={health?.aiConfigured ? formatAiProvider(health.aiProvider) : `${formatAiProvider(health?.aiProvider)} needs key`}
                    detail={health?.aiConfigured ? health.aiModel : undefined}
                    tone={health?.aiConfigured ? "good" : "warn"}
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

          <section className="panel compactPanel sidebarJournal">
            <div className="panelTitle">
              <ClipboardCheck size={18} />
              <h2>Trade journal</h2>
            </div>
            <JournalList journal={journal} />
          </section>
        </aside>

        <section className="mainColumn">
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
                  onSelect={() => (isFullSignal(signal) ? setActiveSignal(signal) : loadSymbol(signal.symbol))}
                />
              ))}
            </div>
          </section>

          <section className="focusGrid">
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

            <aside className="sideRail">
              <section className="panel compactPanel">
                <div className="panelTitle">
                  <ClipboardCheck size={18} />
                  <h2>Paper order</h2>
                </div>
                <PaperOrderForm
                  activeSignal={activeSignal}
                  orderDraft={orderDraft}
                  setOrderDraft={setOrderDraft}
                  onReview={() => setReviewingOrder(true)}
                />
              </section>

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

              <section className="panel compactPanel">
                <div className="panelTitle">
                  <Settings size={18} />
                  <h2>Context + options</h2>
                </div>
                <ContextPanel context={activePlanRecord?.context} />
                <OptionsTable options={options} />
              </section>

              <section className="panel compactPanel">
                <details className="collapseBlock">
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

            </aside>
          </section>
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
                <dd>{orderDraft.orderType === "limit" ? formatCurrency(orderDraft.limitPrice) : "Market"}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{orderDraft.quantity ? `${orderDraft.quantity} shares` : formatCurrency(orderDraft.notional)}</dd>
              </div>
              <div>
                <dt>Stop</dt>
                <dd>{formatCurrency(orderDraft.stopLossPrice)}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>{formatCurrency(orderDraft.takeProfitPrice)}</dd>
              </div>
            </dl>
            <button className="wideButton danger" onClick={submitPaperOrder} disabled={busy === "order"}>
              {busy === "order" ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
              <span>Submit paper order</span>
            </button>
          </section>
        </div>
      )}
    </main>
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
                    <span>{formatCurrency(candidate.lastPrice)}</span>
                    <span>{candidate.riskReward ? `${candidate.riskReward}:1` : "-- R/R"}</span>
                    <span>{candidate.upsidePct ? `${formatPct(candidate.upsidePct)} room` : "-- room"}</span>
                  </div>
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
  onReview
}: {
  activeSignal: SignalSnapshot | null;
  orderDraft: PaperOrderRequest;
  setOrderDraft: (next: PaperOrderRequest | ((draft: PaperOrderRequest) => PaperOrderRequest)) => void;
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
      {plan.entryRequirements && <ListBlock title="Before Entry" items={plan.entryRequirements} />}
      <ListBlock title="Thesis" items={plan.thesis} />
      <ListBlock title="Risk" items={plan.riskNotes} />
      {plan.doNotTradeIf && <ListBlock title="Do Not Trade If" items={plan.doNotTradeIf} />}
      {plan.optionsNotes && <ListBlock title="Options Notes" items={plan.optionsNotes} />}
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

function JournalList({ journal }: { journal: TradeJournalEntry[] }) {
  if (!journal.length) return <EmptyState text="No journal entries yet" />;

  return (
    <div className="journalList">
      {journal.slice(0, 6).map((entry) => (
        <article key={entry.id}>
          <div>
            <strong>{entry.symbol}</strong>
            <span>{entry.status.replace("_", " ")}</span>
          </div>
          <p>{formatAction(entry.action)} - {entry.notes || "No notes"}</p>
          <small>{formatDateTime(entry.createdAt)}</small>
        </article>
      ))}
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="listBlock">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
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

function formatPct(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
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
