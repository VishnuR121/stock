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
   PORT=3001
   ```

   `ALPHA_VANTAGE_API_KEY` is optional. Without it, AI plans still work but will not include Alpha Vantage earnings, fundamentals, or news context. `SEC_USER_AGENT` is used for free SEC EDGAR requests; set it to something that identifies your local app and contact email.

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
- AI plans can include optional Alpha Vantage context and free SEC EDGAR filings/facts.
- AI plans and journal entries are saved in `data/app-data.json`.

## Verification

```bash
npm test
npm run build
```
