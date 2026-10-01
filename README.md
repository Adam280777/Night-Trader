# Trading Bot

A serverless quantitative trading platform that coordinates two strategies on one Trading 212 account:

- **Overnight** researches liquid stocks, enters shortly before the close, and exits at the next open.
- **Intraday momentum** scans an operator-owned liquid-stock watchlist using five-minute bars, enters only during a configured window, and manages stop, target, trailing-stop, maximum-hold, and session-close exits.

Both strategies run through one scheduler, database, order-safety layer, dashboard, and audit trail. They are
configured independently but share the kill switch, unknown-order pause, account cash and position caps, loss
circuit breakers, execution telemetry, and the rule that only one position can be open at a time. Runs fully in
the cloud, so your PC can be off.

**No AI provider, no AI API keys, no per-run cost.** Every decision is made by a quantitative engine that runs inside
the app: a logistic model trained on the app's own past outcomes, conditional historical analogues of each stock's
own behaviour, a free headline sentiment engine, and rules mined from the outcome history. Market data and news come
from Yahoo Finance, which needs no key. Trading 212 supplies the tradable instrument map, exchange schedule, account
state, orders, positions, and authoritative fills.

## How the intraday strategy works

1. The one-minute scheduler checks whether each enabled market is inside its configured entry window.
2. On the configured scan interval, Yahoo five-minute bars and a timestamped quote are loaded for the configured
   watchlist. Symbols must also map to a liquid, non-leveraged Trading 212 stock.
3. A deterministic momentum setup checks 20-minute movement, fast/slow EMA alignment, VWAP, relative volume,
   recent-high breakout, quote freshness, and quoted spread. Every threshold is configurable.
4. The best passing setup becomes a normal persisted run and decision. It uses the same approval flow, fresh
   account checks, sizing caps, order-intent persistence, fill reconciliation, slippage measurement, and
   unknown-outcome pause as the overnight strategy.
5. Each scheduler tick manages an open intraday trade. Stop loss, profit target, trailing stop, maximum hold time,
   and a close-of-session deadline can initiate an exit. The exact app-owned quantity is sold.
6. Daily trade limits and an exit cooldown prevent repeated churn. Intraday results are reported separately and
   never train or contaminate the overnight close-to-open model.

The intraday module starts with signal generation enabled but **intraday order permission disabled**. Global order
placement and, for live accounts, the typed live confirmation are additional independent gates.

## How the decision is made

1. **Study, all day** — between live tasks the engine works through the tradable universe on rotation, scoring
   names and reading their headlines, and stores what it finds in a knowledge base. By the time a decision is due
   it is drawing on research it already has rather than starting cold. Study only ever uses time left over after
   trading work, so it can never delay a trade.
2. **Screen** — the tradable list comes from Trading 212, filtered to liquid non-leveraged stocks and ranked on
   momentum, relative volume, overnight gap history, volatility and position in range, down to about eight names.
   Names with a consistently good record in the knowledge base can claim a few extra shortlist slots.
3. **Research** — for each name the app pulls several years of daily bars plus free headlines, scores the headlines
   with a finance-tuned lexicon and classifies events (earnings, guidance, ratings, legal, M&A…). Research already
   gathered during the day is reused while it is still fresh, and anything new is folded back into the base.
4. **Evaluate** — each candidate becomes a feature vector. A calibrated probability of clearing round-trip costs is
   blended in log-odds from the learned model, kernel-weighted historical analogues, and mined rules.
5. **Decide** — expected move minus costs gives an edge; names are ranked on a risk-adjusted (lower-bound) edge and
   sized with a fraction of Kelly. If nothing clears the bar the answer is no trade.
6. **Guardrails** — position caps, minimum cash, daily/weekly loss breakers, cost checks and the kill switch sit
   downstream and cannot be overridden.
7. **Learn** — the overnight return of *every* shortlisted name is recorded, picked or not. Those counterfactuals
   train the model and re-derive the rule set, so it sharpens every trading day.

Only the *decision to look at* a name comes from the knowledge base. Every number the model is judged on is
recomputed from fresh prices at decision time, so a stale stored score can never size a position.

## Watching it work

The **Live activity** page is a running feed of what the engine is doing: the active strategy and stage, overnight
shortlists, intraday scan reasons, recently studied symbols, and every logged event as it happens. It refreshes
every few seconds and can be paused.

The dashboard shows both strategy modules, their run/trade evidence, the active strategy, position stop/target
information, an equity curve, run-outcome breakdown, and return calendar. The **Learning** page remains explicitly
about the overnight model and adds its return distribution, model reliability plot, and weight comparison while
retaining the underlying tables. **Logs** exposes searchable
structured context and CSV export. **System health** shows scheduler heartbeat, job success and duration, recent
failures, log volume, and database growth.

Operational settings control snapshot, outcome, learning and backfill cadence; log, job and equity retention;
the worker-offline and slow-job thresholds; and successful-job verbosity. Background-job timings and failures are
recorded independently of verbose logging, and operational data is pruned automatically without deleting trading
history or learned model state.

For monitoring outside the dashboard, point an uptime service at `GET /api/health`; it returns a non-200 response
when scheduler heartbeats stop or an order outcome is unresolved. Set `HEALTH_SECRET` to require a bearer token.
Setting `ALERT_WEBHOOK_URL` also sends deduplicated critical-error JSON to an operator-owned webhook. Execution
orders retain their reference quote, quote age, available spread, actual fill, and adverse slippage.

## Tuning the model

Every constant the engine uses is defined once in [`src/lib/quant/tuning.ts`](src/lib/quant/tuning.ts): a zod schema
with the shipped defaults, plus the label, range and plain-English explanation of each parameter. The **Quant
settings** page is generated from that registry, so a parameter cannot exist in the engine without being adjustable,
or appear in the UI without being real.

Around forty parameters are exposed across seven groups — decision engine (Kelly fraction, uncertainty charge,
analogue blending, probability ceiling), costs, screening, hard vetoes, learning (learning rate, rule significance
and caps), headlines, and continuous study (how often it studies, how much it covers, how long knowledge stays
fresh). There is a search box over every parameter, Cautious / Balanced / Aggressive presets, per-parameter and
per-section resets, and anything moved off its default is marked. Changes apply to the next run; nothing is
retroactive, and the safety limits — which stay on the **Settings** page — are enforced separately and cannot be
raised from here.

The **Ask the model** page answers from the same registry, so you can ask what any setting does, how the system is
currently configured, what it has been studying, or what moving a given parameter would change. Conversations clear
on demand and start fresh after a few hours of quiet.

## How it runs in the cloud

- **Vercel** hosts the dashboard and the API.
- **Turso** (hosted SQLite, free tier) stores everything.
- An **external timer** calls `GET /api/cron/tick` (header `Authorization: Bearer <CRON_SECRET>`) every minute.
  Each call first recovers interrupted work and manages open positions, then advances overnight work and eligible
  intraday scans, and finally runs housekeeping. Work resumes safely if interrupted. Any time
  left over at the end of a call goes to studying the universe, so the knowledge base grows on the same timer.

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
There is a kill switch, position caps, a daily/weekly loss breaker and independent approval/order switches.
Nothing here can guarantee returns. Overnight holds carry gap risk. Intraday data is polled rather than streamed,
so a fast move can cross a software-managed exit before the next scheduler tick. Vercel, Yahoo, the external timer,
the database, and Trading 212 are all dependencies; broker-side protection should be preferred whenever it becomes
available through the public API. Stamp duty, FX fees, spread, and slippage can erase small edges. Both strategies
are deliberately willing to sit out. This is not financial advice.
