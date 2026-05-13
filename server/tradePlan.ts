import type { DeterministicTradePlan, MarketRegimeSnapshot, RiskSettings, SignalSnapshot, TradeAction } from "../src/shared/types";
import { round } from "./indicators";
import { rankSignalSnapshot } from "./ranking";

interface BuildDeterministicTradePlanInput {
  snapshot: SignalSnapshot;
  riskSettings: RiskSettings;
  marketRegime?: MarketRegimeSnapshot | null;
  now?: Date;
}

export function buildDeterministicTradePlan(input: BuildDeterministicTradePlanInput): DeterministicTradePlan {
  const ranking = rankSignalSnapshot({
    snapshot: input.snapshot,
    riskSettings: input.riskSettings,
    marketRegime: input.marketRegime,
    now: input.now
  });
  const action = getPlanAction(ranking.action, input.snapshot);
  const riskMultiplier = input.marketRegime?.riskAdjustmentMultiplier ?? 1;
  const adjustedShares = typeof input.snapshot.positionSizeShares === "number"
    ? Math.floor(input.snapshot.positionSizeShares * riskMultiplier)
    : null;
  const adjustedNotional = adjustedShares && input.snapshot.lastPrice
    ? round(adjustedShares * input.snapshot.lastPrice, 2)
    : adjustedShares === 0 ? 0 : input.snapshot.positionNotional;
  const adjustedRisk = input.snapshot.riskDollars !== null
    ? round(input.snapshot.riskDollars * riskMultiplier, 2)
    : null;

  return {
    symbol: input.snapshot.symbol,
    generatedAt: (input.now ?? new Date()).toISOString(),
    currentPrice: input.snapshot.lastPrice,
    marketRegime: input.marketRegime ?? null,
    bias: ranking.bias,
    action,
    entryZone: getEntryZone(input.snapshot),
    stopLoss: input.snapshot.suggestedStop,
    conservativeTarget: input.snapshot.suggestedTarget,
    aggressiveTarget: getAggressiveTarget(input.snapshot),
    riskReward: input.snapshot.riskReward,
    positionSizeShares: adjustedShares,
    positionNotional: adjustedNotional,
    maxRiskDollars: adjustedRisk,
    invalidationCondition: getInvalidationCondition(input.snapshot),
    timeHorizon: "Swing trade: several days to a few weeks, reviewed daily.",
    keyReasons: ranking.reasons.slice(0, 5),
    keyRisks: getKeyRisks(input.snapshot, input.riskSettings, input.marketRegime),
    warnings: [...new Set([...ranking.warnings, ...getPlanWarnings(input.snapshot, input.riskSettings, input.marketRegime)])],
    ranking
  };
}

function getPlanAction(action: ReturnType<typeof rankSignalSnapshot>["action"], snapshot: SignalSnapshot): TradeAction {
  if (action === "buy" && snapshot.bias === "bullish") return "paper_long_candidate";
  if (action === "avoid") return "avoid";
  return "watch";
}

function getEntryZone(snapshot: SignalSnapshot) {
  if (!snapshot.lastPrice) return { low: null, high: null };
  const buffer = snapshot.atr14 ? Math.min(snapshot.atr14 * 0.25, snapshot.lastPrice * 0.01) : snapshot.lastPrice * 0.005;
  return {
    low: round(snapshot.lastPrice - buffer, 2),
    high: round(snapshot.lastPrice + buffer, 2)
  };
}

function getAggressiveTarget(snapshot: SignalSnapshot): number | null {
  if (!snapshot.lastPrice || !snapshot.atr14) return snapshot.suggestedTarget;
  const atrTarget = snapshot.lastPrice + snapshot.atr14 * 4;
  const conservative = snapshot.suggestedTarget ?? atrTarget;
  return round(Math.max(conservative, atrTarget), 2);
}

function getInvalidationCondition(snapshot: SignalSnapshot): string {
  if (snapshot.suggestedStop) return `Close below ${snapshot.suggestedStop} or a decisive break of the stop level invalidates the setup.`;
  return "Missing stop level invalidates this setup until fresh data is available.";
}

function getKeyRisks(snapshot: SignalSnapshot, riskSettings: RiskSettings, marketRegime?: MarketRegimeSnapshot | null): string[] {
  const risks: string[] = [
    "This is paper-trading research, not financial advice.",
    `Configured minimum risk/reward is ${riskSettings.minRiskReward}:1.`
  ];
  if ((snapshot.riskReward ?? 0) > 0 && (snapshot.riskReward ?? 0) < riskSettings.minRiskReward) risks.push("Risk/reward is below the configured floor.");
  if (snapshot.rsi14 !== null && snapshot.rsi14 > 70) risks.push("RSI is elevated; avoid chasing a late entry.");
  if (marketRegime?.regime === "bearish" || marketRegime?.regime === "caution") risks.push(`Market regime is ${marketRegime.regime}; reduce size and require stronger confirmation.`);
  if (!snapshot.suggestedStop || !snapshot.suggestedTarget) risks.push("Stop or target is missing.");
  return risks;
}

function getPlanWarnings(snapshot: SignalSnapshot, riskSettings: RiskSettings, marketRegime?: MarketRegimeSnapshot | null): string[] {
  const warnings: string[] = [];
  if (riskSettings.killSwitchEnabled) warnings.push("Kill switch is enabled; paper order entry is disabled.");
  if (!snapshot.lastPrice) warnings.push("Current price is unavailable.");
  if (!snapshot.suggestedStop || !snapshot.suggestedTarget) warnings.push("A valid stop and target are required before paper order creation.");
  if (marketRegime?.warnings[0]) warnings.push(marketRegime.warnings[0]);
  return warnings;
}
