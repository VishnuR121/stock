import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  HelpCircle,
  LineChart,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Target,
  Trash2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  BrokerAccountSnapshot,
  EnrichedTradePlanResponse,
  HealthStatus,
  OptionIdea,
  PaperOrderRequest,
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
  const [tradePlans, setTradePlans] = useState<Record<string, SavedTradePlan>>({});
  const [journal, setJournal] = useState<TradeJournalEntry[]>([]);
  const [options, setOptions] = useState<OptionIdea[]>([]);
  const [account, setAccount] = useState<BrokerAccountSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionsResponse | null>(null);
  const [orderDraft, setOrderDraft] = useState<PaperOrderRequest>(emptyOrder);
  const [reviewingOrder, setReviewingOrder] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void refreshBasics();
  }, []);

  useEffect(() => {
    if (!activeSignal) return;
    setOrderDraft((draft) => ({
      ...draft,
      symbol: activeSignal.symbol,
      stopLossPrice: activeSignal.suggestedStop ?? draft.stopLossPrice,
      takeProfitPrice: activeSignal.suggestedTarget ?? draft.takeProfitPrice
    }));
    void loadOptions(activeSignal.symbol);
  }, [activeSignal]);

  const sortedSnapshots = useMemo(() => {
    return [...snapshots].sort((left, right) => right.score - left.score);
  }, [snapshots]);
  const activePlanRecord = activeSignal ? tradePlans[activeSignal.symbol] : undefined;
  const activeTradePlan = activePlanRecord?.plan ?? null;

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
      await Promise.all([loadAccount(), loadPositions(), loadSavedPlans(), loadJournal()]);
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
        <button className="iconButton" onClick={refreshBasics} title="Refresh status" aria-label="Refresh status">
          {busy === "refresh" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
        </button>
      </section>

      <section className="statusGrid">
        <StatusTile
          icon={<ShieldCheck size={20} />}
          label="Broker"
          value={health?.alpacaConfigured ? "Connected" : "Needs keys"}
          tone={health?.alpacaConfigured ? "good" : "warn"}
        />
        <StatusTile
          icon={<Bot size={20} />}
          label="OpenAI"
          value={health?.openAiConfigured ? health.openAiModel : "Needs key"}
          tone={health?.openAiConfigured ? "good" : "warn"}
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

      {message && (
        <div className="notice" role="status">
          <AlertTriangle size={18} />
          <span>{message}</span>
        </div>
      )}

      <section className="workspace">
        <aside className="panel sidebar">
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
          <div className="sidebarAccount">
            <div className="panelTitle">
              <Activity size={18} />
              <h2>Paper account</h2>
            </div>
            <AccountPanel account={account} positions={positions} />
          </div>
        </aside>

        <section className="mainColumn">
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

          <section className="detailGrid">
            <section className="panel detailPanel">
              <div className="panelTitle spaced">
                <div>
                  <h2>{activeSignal?.symbol ?? "Symbol detail"}</h2>
                  <p>{activeSignal ? `${activeSignal.trend} - ${activeSignal.bias}` : "Select a ticker"}</p>
                </div>
                <button className="textButton" onClick={generateTradePlan} disabled={!activeSignal || busy === "ai"}>
                  {busy === "ai" ? <Loader2 className="spin" size={17} /> : <Bot size={17} />}
                  <span>{activeSignal && activePlanRecord ? "Refresh plan" : "AI plan"}</span>
                </button>
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
                </>
              ) : (
                <EmptyState text="No signal loaded" />
              )}
            </section>

            <section className="panel">
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
          </section>

          <section className="detailGrid">
            <section className="panel">
              <div className="panelTitle">
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

            <section className="panel">
              <div className="panelTitle">
                <Settings size={18} />
                <h2>Context + options</h2>
              </div>
              <ContextPanel context={activePlanRecord?.context} />
              <OptionsTable options={options} />
            </section>
          </section>

          <section className="panel">
            <div className="panelTitle">
              <ClipboardCheck size={18} />
              <h2>Trade journal</h2>
            </div>
            <JournalList journal={journal} />
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

function StatusTile({ icon, label, value, tone }: { icon: JSX.Element; label: string; value: string; tone: string }) {
  return (
    <article className={`statusTile ${tone}`}>
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </article>
  );
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
            <th>Max loss</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((option) => (
            <tr key={option.symbol}>
              <td>{option.symbol}</td>
              <td>{option.type}</td>
              <td>{option.expirationDate}</td>
              <td>{formatCurrency(option.strikePrice)}</td>
              <td>{formatCurrency(option.maxLoss)}</td>
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
    <div className="accountGrid">
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
