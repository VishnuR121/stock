# Alpaca Paper Trading Research Copilot

AI-assisted swing trading research and paper-trading copilot for stocks and ETFs.

The app scans a watchlist or stock/ETF universe, ranks setups, explains market regime, builds deterministic risk-managed trade plans, lets AI explain those plans, runs historical backtests, places Alpaca paper bracket orders, and tracks journal outcomes.

This is an educational research and paper-trading tool. It is not financial advice. It does not support live-money trading, autonomous trading, crypto leverage, 0DTE workflows, or options order placement.

## Current Capabilities

- Watchlist scanning with technical indicators and setup scores.
- Market regime classifier using SPY and QQQ.
- Transparent ranking model with trend, momentum, risk/reward, volume, volatility, RSI, and regime adjustments.
- Deterministic quantitative trade plan with entry zone, stop, targets, position size, max risk, invalidation, reasons, risks, and warnings.
- AI plan explanation through OpenAI or Anthropic-style providers, constrained to the deterministic quantitative plan.
- Decision Center analysis from deterministic specialist reports plus a manager synthesis.
- Backtest v1 for long-only swing setups, including SPY benchmark comparison and optional historical market-regime filters.
- Alpaca paper-only bracket order flow with stop loss, take profit, event check, risk acceptance, paper-only confirmation, validation, and kill switch.
- Paper trade journal, saved plans, analysis runs, position monitoring, and journal analytics.
- Options research views for education and comparison only.
- Local JSON storage by default, with optional Postgres/Supabase storage through Drizzle.

## Safety Boundaries

- Alpaca live trading URLs are rejected server-side.
- Paper mode is the only execution mode.
- Paper orders require stop loss, take profit, paper-only confirmation, risk acceptance, and earnings/event confirmation.
- The kill switch blocks paper order submission while enabled.
- AI explains structured quantitative inputs; it must not invent a different trade or override risk controls.
- Backtests can be misleading and do not predict future returns.
- Past performance does not guarantee future results.
- Options are analyze-only: no options orders, no 0DTE workflow, no naked options, and no AI-selected options execution.
- TradingView webhook alerts are review-only signal inputs and never submit orders directly.

## Main Workspaces

- **Overview:** market regime, paper account status, risk controls, opportunities, open positions, and warnings.
- **Research:** watchlist scans, opportunity scan, ranked setups, symbol detail, quant plan, Decision Center, AI plan, context, and options research.
- **Trade Plan:** deterministic quant plan, AI explanation, journal actions, and paper-order drafting for the active setup.
- **Backtests:** historical strategy test, market-regime filters, summary metrics, equity curve table, trade table, and SPY comparison.
- **Algo:** approval queue for paper-trade proposals. Options proposals remain research-only.
- **Positions / Orders:** paper positions, paper orders, position monitor, close/flatten controls, and safety controls.
- **Journal:** filterable watching, open, closed, and skipped journal entries with paper-trade analytics.
- **Settings:** paper account details, appearance, risk controls, kill switch, and API/data-provider status.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local` and fill in paper credentials:

   ```bash
   ALPACA_API_KEY_ID=
   ALPACA_API_SECRET_KEY=
   ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets
   AI_PROVIDER=openai
   OPENAI_API_KEY=
   OPENAI_MODEL=gpt-5.4-mini
   ANTHROPIC_API_KEY=
   ANTHROPIC_MODEL=claude-sonnet-4-6
   ALPHA_VANTAGE_API_KEY=
   SEC_USER_AGENT=ResearchCopilot/0.1 your-email@example.com
   DATABASE_URL=
   DATA_FILE_PATH=data/app-data.json
   TRADINGVIEW_WEBHOOK_SECRET=
   PORT=3001
   ```

   `AI_PROVIDER` can be `openai` or `anthropic`. Configure the matching API key and model.

   `ALPHA_VANTAGE_API_KEY` is optional. Without it, AI and Decision Center flows still work but have less fundamentals, earnings, and news context.

   `SEC_USER_AGENT` is used for free SEC EDGAR requests. Set it to identify your local app and contact email. If it is omitted, SEC filings and company facts are skipped instead of using a placeholder identity.

   `DATABASE_URL` is optional. If it is empty, the app uses `data/app-data.json`. If it is set to a Postgres/Supabase URL, the Node server stores watchlists, scans, cached context, AI plans, Decision Center analyses, TradingView signals, settings, and journal entries in Postgres.

   `TRADINGVIEW_WEBHOOK_SECRET` is optional. Set it before using `/api/tradingview/webhook`.

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open:

   ```text
   http://127.0.0.1:5173
   ```

## Optional Supabase/Postgres Storage

Keep the database private on the server. Do not put Supabase keys or database URLs in frontend code.

1. Create a Supabase project or another Postgres database.
2. Copy the Postgres connection string into `.env.local` as `DATABASE_URL`.
3. Push the schema when setting up a fresh database:

   ```bash
   npm run db:push
   ```

4. Import existing local JSON data if needed:

   ```bash
   npm run db:import-json
   ```

Useful database commands:

```bash
npm run db:generate
npm run db:push
npm run db:studio
```

Journal source metadata, follow-plan flags, signal timestamps, and exit reasons are stored in both JSON and Postgres. Run `npm run db:push` or apply the included Drizzle migrations after pulling schema changes.

## Backtesting Notes

Backtest v1 is intentionally simple and conservative:

- Uses historical bars only.
- Builds signals from data available up to each decision date.
- Enters on the next bar after the signal date.
- Exits on stop, target, holding period, score drop, bearish market regime, or end of data.
- Compares strategy results against SPY buy-and-hold.
- Supports optional market-regime filters using historical SPY and QQQ data.

Backtests are research tools. They can be affected by data quality, survivorship bias, assumptions about fills, and changing market conditions.

## Options Policy

Allowed:

- Options idea display.
- Breakeven, max loss, probability, and liquidity education.
- Covered call, cash-secured put, long option, and debit spread research.

Not allowed:

- Options order placement.
- 0DTE or weekly YOLO workflows.
- Naked options.
- AI-selected options execution.

## Verification

Run these before merging a larger implementation chunk:

```bash
npm test
npm run build
```
