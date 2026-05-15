# Alpaca Paper Trading Research Copilot

AI-assisted swing trading research and multi-position paper-trading copilot for stocks, ETFs, and selected options expressions.

The app scans a watchlist or stock/ETF universe, ranks setups, explains market regime, builds deterministic risk-managed trade plans, compares trade expressions, lets AI explain those plans, runs historical long-equity backtests, places Alpaca paper equity bracket orders, internally simulates selected options paper trades, and tracks journal outcomes.

This is an educational research and paper-trading tool. It is not financial advice. It does not support live-money trading, autonomous trading, crypto leverage, naked options, or 0DTE workflows by default.

## Current Capabilities

- Watchlist scanning with technical indicators and setup scores.
- Market regime classifier using SPY and QQQ.
- Transparent ranking model with trend, momentum, risk/reward, volume, volatility, RSI, and regime adjustments.
- Deterministic quantitative trade plan with entry zone, stop, targets, position size, max risk, invalidation, reasons, risks, and warnings.
- AI plan explanation through OpenAI or Anthropic-style providers, constrained to the deterministic quantitative plan.
- Decision Center analysis from deterministic specialist reports plus a manager synthesis.
- Trade Expression Engine that compares long equity, short equity, long calls, long puts, covered calls, cash-secured puts, debit spreads, research-only credit spreads, research-only iron condors, and no-trade.
- Backtest v1 for long-only stock/ETF swing setups, including SPY benchmark comparison and optional historical market-regime filters.
- Alpaca paper-only stock/ETF bracket order flow with stop loss, take profit, event check, risk acceptance, paper-only confirmation, validation, and kill switch.
- Short stock/ETF paper trades when the paper order has a required stop, target, position cap, and max-risk estimate.
- Options paper simulation for selected defined-risk or covered/cash-secured strategies: long calls, long puts, bull call debit spreads, bear put debit spreads, covered calls, and cash-secured puts.
- Internal options simulation monitor with mark-to-market estimates, exposure by strategy/underlying/DTE, exit guidance, and explicit paper-simulation close flow.
- Paper trade journal, saved plans, analysis runs, equity position monitoring, options simulation monitoring, and journal analytics by expression type, underlying, regime, confidence, DTE bucket, option type, and spread/single-leg structure.
- Options research views with contract pricing, DTE, liquidity, IV, Greeks when available, breakeven, and max-loss estimates.
- Postgres/Supabase storage through Drizzle. Runtime JSON storage is disabled.

## Safety Boundaries

- Alpaca live trading URLs are rejected server-side.
- Paper mode is the only execution mode.
- Paper orders require stop loss, take profit, paper-only confirmation, risk acceptance, and earnings/event confirmation.
- Options paper simulations require paper-only confirmation, risk acceptance, event check, max-loss acknowledgement, internal-simulation acknowledgement, no-live-endpoint acknowledgement, liquidity checks, and contract data.
- Options simulation creation checks open paper journal exposure, max open positions, max options contracts, and same-underlying strategy exposure before a new simulation is created.
- Closing an options simulation updates only the internal paper journal. It does not submit broker options orders.
- The kill switch blocks paper order submission while enabled.
- AI explains structured quantitative inputs and deterministic expression output; it must not invent option contracts, invent prices, override max loss, hide warnings, override the kill switch, recommend live trading, or submit orders.
- Backtest v1 currently validates long stock/ETF swing strategies using historical OHLCV data. It does not validate options, spreads, covered calls, cash-secured puts, short trades, or multi-leg positions.
- Past performance does not guarantee future results.
- Options paper trading is simulation only and may differ from live fills or live assignment behavior.
- No naked options, undefined-risk options, live options execution, AI-selected options execution, or 0DTE by default.
- TradingView webhook alerts are review-only signal inputs and never submit orders directly.

## Main Workspaces

- **Overview:** market regime, paper account status, risk controls, opportunities, open positions, and warnings.
- **Research:** watchlist scans, opportunity scan, ranked setups, symbol detail, quant plan, Trade Expression comparison, Decision Center, AI plan, context, and options research.
- **Trade Plan:** deterministic quant plan, expression comparison, AI explanation, journal actions, and paper-order drafting for the active setup.
- **Backtests:** historical strategy test, market-regime filters, summary metrics, equity curve table, trade table, and SPY comparison.
- **Algo:** approval queue for paper-trade proposals. Options proposals remain research-only.
- **Positions / Orders:** paper positions, equity paper orders, internally simulated options paper entries, position monitor, close/flatten controls, and safety controls.
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
   TRADINGVIEW_WEBHOOK_SECRET=
   PORT=3001
   ```

   `AI_PROVIDER` can be `openai` or `anthropic`. Configure the matching API key and model.

   `ALPHA_VANTAGE_API_KEY` is optional. Without it, AI and Decision Center flows still work but have less fundamentals, earnings, and news context.

   `SEC_USER_AGENT` is used for free SEC EDGAR requests. Set it to identify your local app and contact email. If it is omitted, SEC filings and company facts are skipped instead of using a placeholder identity.

   `DATABASE_URL` is required. The Node server stores watchlists, scans, cached context, AI plans, Decision Center analyses, TradingView signals, settings, and journal entries in Postgres/Supabase.

   `TRADINGVIEW_WEBHOOK_SECRET` is optional. Set it before using `/api/tradingview/webhook`.

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open:

   ```text
   http://127.0.0.1:5173
   ```

## Supabase/Postgres Storage

Keep the database private on the server. Do not put Supabase keys or database URLs in frontend code.

1. Create a Supabase project or another Postgres database.
2. Copy the Postgres connection string into `.env.local` as `DATABASE_URL`.
3. Apply database migrations:

   ```bash
   npm run db:migrate
   ```

   `npm run db:migrate` applies the SQL files in `drizzle/` and tracks completed migrations in the database. It also discovers SQL migrations even if Drizzle journal metadata was not updated, which avoids the `drizzle-kit push` introspection path that can fail on some hosted Postgres schemas.

   `npm run db:push` is intentionally aliased to the same migration runner for this repo. Do not use raw `drizzle-kit push` against the production database.

4. Import existing local JSON data once if needed:

   ```bash
   npm run db:import-json
   ```

Useful database commands:

```bash
npm run db:generate
npm run db:migrate
npm run db:push
npm run db:studio
```

Journal source metadata, follow-plan flags, signal timestamps, expression type, underlying symbol, option legs, max loss, max profit, breakeven, required capital, paper execution mode, strategy warnings, realized P/L, actual R multiple, and exit reasons are stored in Postgres. The JSON import command is only for one-time migration from old local files.

## Backtesting Notes

Backtest v1 is intentionally simple, conservative, and long-equity only:

- Uses historical bars only.
- Builds signals from data available up to each decision date.
- Enters on the next bar after the signal date.
- Exits on stop, target, holding period, score drop, bearish market regime, or end of data.
- Compares strategy results against SPY buy-and-hold.
- Supports optional market-regime filters using historical SPY and QQQ data.
- Does not validate options, spreads, covered calls, cash-secured puts, short equity, or multi-leg positions.

Backtests are research tools. They can be affected by data quality, survivorship bias, assumptions about fills, and changing market conditions.

## Options Policy

Allowed:

- Options idea display and trade-expression comparison.
- Breakeven, max loss, probability, DTE, pricing, Greeks when available, and liquidity education.
- Covered call, cash-secured put, long option, and debit spread research.
- Internal paper simulation for long calls, long puts, covered calls, cash-secured puts, bull call debit spreads, and bear put debit spreads after explicit confirmation.
- Internal monitoring and manual close-out of options simulations with P/L, DTE, liquidity, assignment-risk, and max-loss guidance.

Not allowed:

- Live options order placement.
- Broker options submission unless it is explicitly implemented and validated later.
- 0DTE or weekly YOLO workflows.
- Naked options.
- Undefined-risk options.
- True options backtesting.
- AI-selected options execution.

## Verification

Run these before merging a larger implementation chunk:

```bash
npm test
npm run build
```
