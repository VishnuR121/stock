# Alpaca Paper Trading Research Copilot

Local swing-trading research dashboard with Alpaca paper trading, OpenAI trade-plan summaries, technical scans, and analyze-only options views.

This is a research and paper-trading tool. It does not include live-money trading, automated trading, or options order placement.

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
   OPENAI_API_KEY=
   OPENAI_MODEL=gpt-5.4-mini
   ALPHA_VANTAGE_API_KEY=
   SEC_USER_AGENT=ResearchCopilot/0.1 your-email@example.com
   DATABASE_URL=
   DATA_FILE_PATH=data/app-data.json
   TRADINGVIEW_WEBHOOK_SECRET=
   PORT=3001
   ```

   `ALPHA_VANTAGE_API_KEY` is optional. Without it, AI plans still work but will not include Alpha Vantage earnings, fundamentals, or news context. `SEC_USER_AGENT` is used for free SEC EDGAR requests; set it to something that identifies your local app and contact email.
   `DATABASE_URL` is optional. If it is empty, the app uses `data/app-data.json`. If it is set to a Postgres/Supabase URL, the Node server stores watchlists, scans, cached AI context, AI plans, Decision Center analyses, TradingView signals, settings, and journal entries in Postgres.
   `TRADINGVIEW_WEBHOOK_SECRET` is optional. Set it before using `/api/tradingview/webhook`; TradingView alerts are saved as review-only signals and never place orders directly.

### Optional Supabase/Postgres Storage

Keep the database private on the server. Do not put Supabase keys or database URLs in frontend code.

1. Create a Supabase project.
2. Copy a Postgres connection string into `.env.local` as `DATABASE_URL`.
3. Push the schema:

   ```bash
   npm run db:push
   ```

4. Import any existing local JSON data:

   ```bash
   npm run db:import-json
   ```

Useful database commands:

```bash
npm run db:generate
npm run db:push
npm run db:studio
```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open:

   ```text
   http://127.0.0.1:5173
   ```

## Safety Boundaries

- Alpaca live trading URLs are rejected.
- Paper order route only submits long stock/ETF bracket orders.
- Stop loss, take profit, paper-only confirmation, risk acceptance, and earnings/event check are required.
- Options are analyze-only in v1.
- Decision Center analyses use deterministic specialist reports plus one manager synthesis; hard safety blockers take priority.
- The kill switch blocks paper order submission while enabled.
- TradingView webhook alerts are optional signal inputs only; they never submit orders.
- AI plans can include optional Alpha Vantage context and free SEC EDGAR filings/facts.
- AI plans, Decision Center analyses, cached API context, scans, settings, TradingView signals, and journal entries are saved in Postgres when `DATABASE_URL` is set, otherwise in `data/app-data.json`.

## Verification

```bash
npm test
npm run build
```
