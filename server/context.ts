import type {
  EarningsContext,
  FilingItem,
  FundamentalSnapshot,
  NewsItem,
  SecCompanyFacts,
  TradeContext
} from "../src/shared/types";
import type { AppConfig } from "./config";

type ProviderStatus = TradeContext["providers"];

interface AlphaVantageOverview {
  Name?: string;
  Sector?: string;
  Industry?: string;
  MarketCapitalization?: string;
  PERatio?: string;
  PEGRatio?: string;
  ProfitMargin?: string;
  RevenueTTM?: string;
  EPS?: string;
  DividendYield?: string;
  Beta?: string;
  Note?: string;
  Information?: string;
}

interface AlphaVantageNews {
  feed?: Array<{
    title?: string;
    url?: string;
    source?: string;
    time_published?: string;
    summary?: string;
    overall_sentiment_label?: string;
  }>;
  Note?: string;
  Information?: string;
}

interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface SecSubmissions {
  cik?: string;
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      reportDate?: string[];
      form?: string[];
      primaryDocDescription?: string[];
      primaryDocument?: string[];
    };
  };
}

interface SecFactsResponse {
  cik?: number;
  entityName?: string;
  facts?: Record<string, Record<string, { units?: Record<string, SecFactUnit[]> }>>;
}

interface SecFactUnit {
  val?: number;
  end?: string;
  filed?: string;
  form?: string;
  fy?: number;
  fp?: string;
}

export class TradeContextService {
  constructor(private readonly config: AppConfig) {}

  async build(symbol: string): Promise<TradeContext> {
    const context: TradeContext = {
      symbol,
      generatedAt: new Date().toISOString(),
      providers: {
        alpaca: "ok",
        alphaVantage: this.config.alphaVantageApiKey ? "ok" : "missing_key",
        sec: "ok"
      },
      news: [],
      recentFilings: [],
      contextWarnings: []
    };

    const [alpha, sec] = await Promise.all([this.getAlphaVantageContext(symbol), this.getSecContext(symbol)]);

    Object.assign(context, alpha.context);
    context.providers.alphaVantage = alpha.status;
    context.contextWarnings.push(...alpha.warnings);

    context.recentFilings = sec.recentFilings;
    context.secFacts = sec.secFacts;
    context.providers.sec = sec.status;
    context.contextWarnings.push(...sec.warnings);

    return context;
  }

  private async getAlphaVantageContext(symbol: string): Promise<{
    status: ProviderStatus["alphaVantage"];
    context: Partial<TradeContext>;
    warnings: string[];
  }> {
    if (!this.config.alphaVantageApiKey) {
      return {
        status: "missing_key",
        context: {},
        warnings: ["Alpha Vantage key not configured; earnings/news/fundamentals were not added."]
      };
    }

    try {
      const overview = await this.alphaJson<AlphaVantageOverview>({ function: "OVERVIEW", symbol });
      await sleep(1200);
      const calendar = await this.alphaText({ function: "EARNINGS_CALENDAR", symbol, horizon: "3month" });
      await sleep(1200);
      const news = await this.alphaJson<AlphaVantageNews>({
        function: "NEWS_SENTIMENT",
        tickers: symbol,
        limit: "8",
        sort: "LATEST"
      });

      const warnings = [
        ...alphaWarnings(overview),
        ...alphaWarnings(news)
      ];

      return {
        status: warnings.some((warning) => warning.toLowerCase().includes("rate limit")) ? "rate_limited" : "ok",
        context: {
          fundamentals: mapOverview(overview),
          earnings: mapEarnings(calendar),
          news: mapNews(news)
        },
        warnings
      };
    } catch (error) {
      return {
        status: "error",
        context: {},
        warnings: [`Alpha Vantage context failed: ${error instanceof Error ? error.message : "unknown error"}.`]
      };
    }
  }

  private async getSecContext(symbol: string): Promise<{
    status: ProviderStatus["sec"];
    recentFilings: FilingItem[];
    secFacts?: SecCompanyFacts;
    warnings: string[];
  }> {
    try {
      const cik = await this.lookupCik(symbol);
      if (!cik) {
        return {
          status: "not_found",
          recentFilings: [],
          warnings: ["SEC CIK not found for this symbol."]
        };
      }

      const padded = cik.padStart(10, "0");
      const [submissions, facts] = await Promise.all([
        this.secJson<SecSubmissions>(`https://data.sec.gov/submissions/CIK${padded}.json`),
        this.secJson<SecFactsResponse>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`).catch(() => null)
      ]);

      return {
        status: "ok",
        recentFilings: mapFilings(submissions, cik),
        secFacts: facts ? mapSecFacts(facts, padded) : undefined,
        warnings: []
      };
    } catch (error) {
      return {
        status: "error",
        recentFilings: [],
        warnings: [`SEC context failed: ${error instanceof Error ? error.message : "unknown error"}.`]
      };
    }
  }

  private async lookupCik(symbol: string): Promise<string | null> {
    const tickers = await this.secJson<Record<string, SecTickerEntry>>("https://www.sec.gov/files/company_tickers.json");
    const match = Object.values(tickers).find((entry) => entry.ticker.toUpperCase() === symbol.toUpperCase());
    return match ? String(match.cik_str) : null;
  }

  private async alphaJson<T>(params: Record<string, string>): Promise<T> {
    const url = new URL("https://www.alphavantage.co/query");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apikey", this.config.alphaVantageApiKey ?? "");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private async alphaText(params: Record<string, string>): Promise<string> {
    const url = new URL("https://www.alphavantage.co/query");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apikey", this.config.alphaVantageApiKey ?? "");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  private async secJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": this.config.secUserAgent,
        Accept: "application/json"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  }
}

function alphaWarnings(body: { Note?: string; Information?: string } | null | undefined): string[] {
  if (!body) return [];
  const message = body.Note || body.Information;
  if (!message) return [];
  return [message.includes("frequency") || message.includes("rate") ? `Alpha Vantage rate limit: ${message}` : message];
}

function mapOverview(overview: AlphaVantageOverview): FundamentalSnapshot | undefined {
  if (!overview.Name && !overview.Sector && !overview.MarketCapitalization) return undefined;
  return {
    source: "Alpha Vantage OVERVIEW",
    name: cleanValue(overview.Name),
    sector: cleanValue(overview.Sector),
    industry: cleanValue(overview.Industry),
    marketCapitalization: cleanValue(overview.MarketCapitalization),
    peRatio: cleanValue(overview.PERatio),
    pegRatio: cleanValue(overview.PEGRatio),
    profitMargin: cleanValue(overview.ProfitMargin),
    revenueTtm: cleanValue(overview.RevenueTTM),
    epsTtm: cleanValue(overview.EPS),
    dividendYield: cleanValue(overview.DividendYield),
    beta: cleanValue(overview.Beta),
    notes: []
  };
}

function mapEarnings(calendarCsv: string): EarningsContext | undefined {
  const next = parseFirstCsvRow(calendarCsv);
  if (!next) return undefined;

  return {
    source: "Alpha Vantage EARNINGS_CALENDAR",
    nextEarningsDate: next?.reportDate,
    nextReportTime: next?.reportTime,
    notes: next?.reportDate ? [`Next listed earnings date: ${next.reportDate}.`] : []
  };
}

function mapNews(news: AlphaVantageNews): NewsItem[] {
  return (news.feed ?? []).slice(0, 6).map((item) => ({
    title: item.title ?? "Untitled headline",
    url: item.url,
    source: item.source,
    publishedAt: item.time_published,
    summary: item.summary,
    sentiment: item.overall_sentiment_label
  }));
}

function mapFilings(submissions: SecSubmissions, cik: string): FilingItem[] {
  const recent = submissions.filings?.recent;
  if (!recent?.form) return [];
  const formsToKeep = new Set(["10-K", "10-Q", "8-K", "DEF 14A", "S-3", "S-8"]);
  const filings: FilingItem[] = [];

  for (let index = 0; index < recent.form.length && filings.length < 8; index += 1) {
    const form = recent.form[index];
    if (!formsToKeep.has(form)) continue;
    const accession = recent.accessionNumber?.[index];
    const primaryDocument = recent.primaryDocument?.[index];
    filings.push({
      form,
      filedAt: recent.filingDate?.[index] ?? "",
      reportDate: recent.reportDate?.[index],
      accessionNumber: accession,
      description: recent.primaryDocDescription?.[index],
      url: accession && primaryDocument
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${primaryDocument}`
        : undefined
    });
  }

  return filings;
}

function mapSecFacts(facts: SecFactsResponse, cik: string): SecCompanyFacts {
  const usGaap = facts.facts?.["us-gaap"] ?? {};
  return {
    cik,
    entityName: facts.entityName,
    latestRevenue: latestFact(usGaap, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]),
    latestNetIncome: latestFact(usGaap, ["NetIncomeLoss"]),
    latestAssets: latestFact(usGaap, ["Assets"]),
    latestLiabilities: latestFact(usGaap, ["Liabilities"]),
    latestCash: latestFact(usGaap, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]),
    notes: ["SEC facts are pulled from company XBRL filings and may use different reporting periods."]
  };
}

function latestFact(facts: Record<string, { units?: Record<string, SecFactUnit[]> }>, tags: string[]): number | null {
  for (const tag of tags) {
    const units = facts[tag]?.units;
    const values = units?.USD ?? units?.shares ?? units?.pure;
    const latest = values
      ?.filter((item) => typeof item.val === "number" && item.end)
      .sort((left, right) => (right.end ?? "").localeCompare(left.end ?? ""))[0];
    if (typeof latest?.val === "number") return latest.val;
  }
  return null;
}

function parseFirstCsvRow(csv: string): { reportDate?: string; reportTime?: string } | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const headers = splitCsvLine(lines[0]);
  const values = splitCsvLine(lines[1]);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  return {
    reportDate: row.reportDate || row.fiscalDateEnding,
    reportTime: row.reportTime
  };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function cleanValue(value?: string): string | undefined {
  if (!value || value === "None" || value === "None%" || value === "-") return undefined;
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
