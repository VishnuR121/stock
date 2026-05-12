import type { Bar, BrokerAccountSnapshot, PaperOrderRequest } from "../src/shared/types";
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
      paper: true
    };
  }

  async getPositions(): Promise<unknown[]> {
    return this.tradingRequest<unknown[]>("/v2/positions");
  }

  async getOrders(): Promise<unknown[]> {
    return this.tradingRequest<unknown[]>("/v2/orders?status=all&limit=50&nested=true");
  }

  async getBars(symbol: string, limit = 260): Promise<Bar[]> {
    const start = new Date();
    start.setDate(start.getDate() - Math.ceil(limit * 2.2));
    const requestLimit = Math.max(limit, Math.ceil(limit * 2.5));
    const params = new URLSearchParams({
      timeframe: "1Day",
      adjustment: "raw",
      feed: "iex",
      limit: String(requestLimit),
      start: start.toISOString()
    });
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
    const params = new URLSearchParams({
      underlying_symbols: symbol,
      limit: "100",
      status: "active"
    });
    const data = await this.tradingRequest<{ option_contracts?: Parameters<typeof mapOptionContractsToIdeas>[0] }>(
      `/v2/options/contracts?${params.toString()}`
    );
    return mapOptionContractsToIdeas(data.option_contracts ?? []);
  }

  async placePaperBracketOrder(order: PaperOrderRequest): Promise<unknown> {
    const body: Record<string, unknown> = {
      symbol: order.symbol,
      side: "buy",
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

function toNumberOrNull(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
