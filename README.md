# AI Overnight Trader

A dashboard where an OpenAI-powered agent researches the market, buys **one** stock shortly before the close and
sells it at the next open, every trading day, then learns from its own results. Connects to Trading 212
(demo or live), US and UK markets, with hard guardrails the AI cannot override. Runs fully in the cloud, so your PC
can be off.

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
4. Open the site, sign in, go to **Settings**, paste your Trading 212 and OpenAI keys and press save (each key is tested before it is stored).
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
There is a kill switch, position caps, a daily/weekly loss breaker and an optional approval step. No AI can guarantee returns:
overnight holds carry gap risk, and stamp duty, FX fees and spread eat small edges. This is not financial advice.
