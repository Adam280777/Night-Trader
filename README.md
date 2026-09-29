# Overnight Trader

A dashboard that researches the market, buys **one** stock shortly before the close and
sells it at the next open, every trading day, then learns from its own results. Connects to Trading 212
(demo or live), US and UK markets, with hard guardrails the decision engine cannot override. Runs fully in the cloud, so your PC
can be off.

**No AI provider, no API keys, no per-run cost.** Every decision is made by a quantitative engine that runs inside
the app: a logistic model trained on the app's own past outcomes, conditional historical analogues of each stock's
own behaviour, a free headline sentiment engine, and rules mined from the outcome history. Market data and news come
from Yahoo Finance, which needs no key. The only external service is Trading 212.

## How the decision is made

1. **Screen** — the tradable list comes from Trading 212, filtered to liquid non-leveraged stocks and ranked on
   momentum, relative volume, overnight gap history, volatility and position in range, down to about eight names.
2. **Research** — for each name the app pulls several years of daily bars plus free headlines, scores the headlines
   with a finance-tuned lexicon and classifies events (earnings, guidance, ratings, legal, M&A…).
3. **Evaluate** — each candidate becomes a feature vector. A calibrated probability of clearing round-trip costs is
   blended in log-odds from the learned model, kernel-weighted historical analogues, and mined rules.
4. **Decide** — expected move minus costs gives an edge; names are ranked on a risk-adjusted (lower-bound) edge and
   sized with a fraction of Kelly. If nothing clears the bar the answer is no trade.
5. **Guardrails** — position caps, minimum cash, daily/weekly loss breakers, cost checks and the kill switch sit
   downstream and cannot be overridden.
6. **Learn** — the overnight return of *every* shortlisted name is recorded, picked or not. Those counterfactuals
   train the model and re-derive the rule set, so it sharpens every trading day.

## Tuning the model

Every constant the engine uses is defined once in [`src/lib/quant/tuning.ts`](src/lib/quant/tuning.ts): a zod schema
with the shipped defaults, plus the label, range and plain-English explanation of each parameter. The **Settings**
page is generated from that registry, so a parameter cannot exist in the engine without being adjustable, or appear
in the UI without being real.

Roughly three dozen parameters are exposed across six groups — decision engine (Kelly fraction, uncertainty charge,
analogue blending, probability ceiling), costs, screening, hard vetoes, learning (learning rate, rule significance
and caps) and headlines. There are Cautious / Balanced / Aggressive presets, each section resets independently, and
anything moved off its default is marked. Changes apply to the next run; nothing is retroactive, and the safety
limits are enforced separately and cannot be raised from here.

The **Ask the model** page answers from the same registry, so you can ask what any setting does, how the system is
currently configured, or what moving a given parameter would change.

## How it runs in the cloud

- **Vercel** hosts the dashboard and the API.
- **Turso** (hosted SQLite, free tier) stores everything.
- An **external timer** calls `GET /api/cron/tick` (header `Authorization: Bearer <CRON_SECRET>`) every minute.
  Each call does one small step (screen, research, decide, buy, sell) and resumes safely if interrupted.

## Deploy

1. Push this repo to a **private** GitHub repository.
2. Create a Turso database (`turso db create trader`, then `turso db show trader --url` and `turso db tokens create trader`).
3. Import the repo in Vercel and set the environment variables from `.env.example`
   (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_PASSWORD`, `SECRETS_KEY`, `CRON_SECRET`). The build applies database migrations automatically.
4. Open the site, sign in, go to **Settings** and paste your Trading 212 key and secret (they are tested before they are stored).
5. Create the timer. Either:
   - **cron-job.org** (recommended, free): a job hitting `https://YOUR-APP.vercel.app/api/cron/tick` every minute with the header
     `Authorization: Bearer <CRON_SECRET>`; or
   - the included GitHub Action (`.github/workflows/tick.yml`, roughly every 5 minutes): add repository secrets `APP_URL` and `CRON_SECRET`.
6. The dashboard shows "Scheduler online" once ticks arrive.

Long runs need Vercel's 300 second function limit (the default on current plans with Fluid Compute).

## Local use

```
npm install
cp .env.example .env.local   # set APP_PASSWORD at least
npm run dev                  # http://localhost:3000
npm run tick                 # run one scheduler tick by hand
npm test
```

Without `TURSO_DATABASE_URL` a local SQLite file (`data/trader.db`) is used.

## Safety

Starts in dry-run (no orders). Demo trading needs a Trading 212 demo key; live trading needs a live key and typing `TRADE LIVE`.
There is a kill switch, position caps, a daily/weekly loss breaker and an optional approval step. Nothing here can guarantee returns:
overnight holds carry gap risk, and stamp duty, FX fees and spread eat small edges. The engine is deliberately willing to
sit out; a no-trade night is a real answer, not a failure. This is not financial advice.
