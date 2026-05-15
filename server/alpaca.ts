import type { Bar, BrokerAccountSnapshot, BrokerAssetSnapshot, MultiLegPaperOrderRequest, PaperOrderRequest } from "../src/shared/types";
import { isPaperAlpacaUrl, type AppConfig } from "./config";
import { mapOptionContractsToIdeas } from "./options";

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaAccount {
  id?: string;
  status?: string;
  currency?: string;
  equity?: string;
  cash?: string;
  buying_power?: string;
  portfolio_value?: string;
  options_trading_level?: string | number | null;
  options_approved_level?: string | number | null;
}

interface AlpacaAsset {
  id?: string;
  class?: string;
  exchange?: string;
  symbol?: string;
  name?: string;
  status?: string;
  tradable?: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easy_to_borrow?: boolean;
  fractionable?: boolean;
}

interface GetBarsOptions {
  limit?: number;
  start?: string;
  end?: string;
}

export class AlpacaClient {
  private readonly tradingBaseUrl: string;
  private readonly marketDataBaseUrl = "https://data.alpaca.markets";

  constructor(private readonly config: AppConfig) {
    this.tradingBaseUrl = config.alpacaPaperBaseUrl.replace(/\/$/, "");
  }

  get configured(): boolean {
    return Boolean(this.config.alpacaKeyId && this.config.alpacaSecretKey);
  }

  assertPaperOnly(): void {
    if (!isPaperAlpacaUrl(this.tradingBaseUrl)) {
      throw new Error("Alpaca live trading URL is blocked. Use https://paper-api.alpaca.markets.");
    }
  }

  async getAccount(): Promise<BrokerAccountSnapshot> {
    const account = await this.tradingRequest<AlpacaAccount>("/v2/account");
    return {
      id: account.id,
      status: account.status,
      currency: account.currency,
      equity: toNumberOrNull(account.equity),
      cash: toNumberOrNull(account.cash),
      buyingPower: toNumberOrNull(account.buying_power),
      portfolioValue: toNumberOrNull(account.portfolio_value),
      paper: true,
      optionsTradingLevel: toNumberOrNull(account.options_trading_level),
      optionsApprovedLevel: toNumberOrNull(account.options_approved_level)
    };
  }

  async getPositions(): Promise<unknown[]> {
    return this.tradingRequest<unknown[]>("/v2/positions");
  }

  async getOrders(): Promise<unknown[]> {
    return this.tradingRequest<unknown[]>("/v2/orders?status=all&limit=50&nested=true");
  }

  async getAsset(symbol: string): Promise<BrokerAssetSnapshot> {
    const asset = await this.tradingRequest<AlpacaAsset>(`/v2/assets/${encodeURIComponent(symbol)}`);
    return {
      id: asset.id,
      symbol: String(asset.symbol ?? symbol).toUpperCase(),
      name: asset.name,
      assetClass: asset.class,
      exchange: asset.exchange,
      status: asset.status,
      tradable: asset.tradable,
      marginable: asset.marginable,
      shortable: asset.shortable,
      easyToBorrow: asset.easy_to_borrow,
      fractionable: asset.fractionable
    };
  }

  async getBars(symbol: string, input: number | GetBarsOptions = 260): Promise<Bar[]> {
    const options = typeof input === "number" ? { limit: input } : input;
    const limit = options.limit ?? 260;
    const start = new Date();
    start.setDate(start.getDate() - Math.ceil(limit * 2.2));
    const requestLimit = Math.max(limit, Math.ceil(limit * 2.5));
    const params = new URLSearchParams({
      timeframe: "1Day",
      adjustment: "raw",
      feed: "iex",
      limit: String(requestLimit),
      start: options.start ?? start.toISOString()
    });
    if (options.end) params.set("end", options.end);
    const data = await this.marketDataRequest<{ bars?: AlpacaBar[] }>(`/v2/stocks/${symbol}/bars?${params.toString()}`);
    return (data.bars ?? []).map((bar) => ({
      timestamp: bar.t,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v
    })).slice(-limit);
  }

  async getSnapshot(symbol: string): Promise<unknown> {
    return this.marketDataRequest(`/v2/stocks/${symbol}/snapshot?feed=iex`);
  }

  async getOptionIdeas(symbol: string) {
    const start = new Date();
    const end = new Date(start);
    end.setDate(end.getDate() + 365);
    const contracts: Parameters<typeof mapOptionContractsToIdeas>[0] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        underlying_symbols: symbol,
        expiration_date_gte: toDateKey(start),
        expiration_date_lte: toDateKey(end),
        limit: "10000",
        status: "active"
      });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.tradingRequest<{ option_contracts?: Parameters<typeof mapOptionContractsToIdeas>[0]; next_page_token?: string }>(
        `/v2/options/contracts?${params.toString()}`
      );
      contracts.push(...(data.option_contracts ?? []));
      pageToken = data.next_page_token;
    } while (pageToken && contracts.length < 50000);

    return mapOptionContractsToIdeas(contracts);
  }

  async placePaperBracketOrder(order: PaperOrderRequest): Promise<unknown> {
    const body: Record<string, unknown> = {
      symbol: order.symbol,
      side: order.side,
      type: order.orderType,
      time_in_force: order.timeInForce,
      order_class: "bracket",
      extended_hours: false,
      take_profit: {
        limit_price: order.takeProfitPrice.toFixed(2)
      },
      stop_loss: {
        stop_price: order.stopLossPrice.toFixed(2)
      },
      client_order_id: `copilot-paper-${Date.now()}`
    };

    if (order.quantity) body.qty = String(order.quantity);
    if (order.notional) body.notional = order.notional.toFixed(2);
    if (order.orderType === "limit" && order.limitPrice) body.limit_price = order.limitPrice.toFixed(2);

    return this.tradingRequest("/v2/orders", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async placePaperOptionsOrder(order: MultiLegPaperOrderRequest): Promise<unknown> {
    const body = buildOptionsOrderBody(order);
    return this.tradingRequest("/v2/orders", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async cancelOpenOrders(): Promise<unknown> {
    return this.tradingRequest("/v2/orders", {
      method: "DELETE"
    });
  }

  async closeAllPositions(): Promise<unknown> {
    return this.tradingRequest("/v2/positions", {
      method: "DELETE"
    });
  }

  async closePosition(symbolOrAssetId: string): Promise<unknown> {
    return this.tradingRequest(`/v2/positions/${encodeURIComponent(symbolOrAssetId)}`, {
      method: "DELETE"
    });
  }

  private async tradingRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.assertPaperOnly();
    return this.request<T>(`${this.tradingBaseUrl}${path}`, init);
  }

  private async marketDataRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(`${this.marketDataBaseUrl}${path}`, init);
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!this.config.alpacaKeyId || !this.config.alpacaSecretKey) {
      throw new Error("Alpaca paper credentials are not configured.");
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        "APCA-API-KEY-ID": this.config.alpacaKeyId,
        "APCA-API-SECRET-KEY": this.config.alpacaSecretKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Alpaca request failed (${response.status}): ${text || response.statusText}`);
    }

    return (await response.json()) as T;
  }
}

function toNumberOrNull(value?: string | number | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildOptionsOrderBody(order: MultiLegPaperOrderRequest): Record<string, unknown> {
  const clientOrderId = `copilot-options-paper-${Date.now()}`;
  if (order.legs.length === 1) {
    const leg = order.legs[0];
    const limitPrice = getSingleLegLimitPrice(leg);
    const body: Record<string, unknown> = {
      symbol: leg.optionSymbol,
      qty: String(leg.quantity),
      side: leg.side,
      type: "limit",
      time_in_force: "day",
      limit_price: limitPrice.toFixed(2),
      position_intent: leg.side === "buy" ? "buy_to_open" : "sell_to_open",
      client_order_id: clientOrderId
    };
    return body;
  }

  const limitPrice = getMultiLegLimitPrice(order);
  return {
    order_class: "mleg",
    qty: "1",
    type: "limit",
    time_in_force: "day",
    limit_price: limitPrice.toFixed(2),
    client_order_id: clientOrderId,
    legs: order.legs.map((leg) => ({
      symbol: leg.optionSymbol,
      ratio_qty: String(leg.quantity),
      side: leg.side,
      position_intent: leg.side === "buy" ? "buy_to_open" : "sell_to_open"
    }))
  };
}

function getSingleLegLimitPrice(leg: MultiLegPaperOrderRequest["legs"][number]): number {
  const price = leg.limitPrice ?? leg.estimatedMid ?? leg.last ?? (leg.bid !== undefined && leg.ask !== undefined ? (leg.bid + leg.ask) / 2 : null);
  return Math.max(0.01, roundMoney(price ?? 0.01));
}

function getMultiLegLimitPrice(order: MultiLegPaperOrderRequest): number {
  if (order.estimatedDebit !== undefined) return Math.max(0.01, roundMoney(order.estimatedDebit / 100));
  if (order.estimatedCredit !== undefined) return -Math.max(0.01, roundMoney(order.estimatedCredit / 100));
  const net = order.legs.reduce((sum, leg) => {
    const price = getSingleLegLimitPrice(leg);
    return sum + (leg.side === "buy" ? price : -price) * leg.quantity;
  }, 0);
  return roundMoney(net);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
