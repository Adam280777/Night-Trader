import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings, currentMode } from "../lib/config";
import { log } from "../lib/log";
import { getAccountState, tryClient } from "../lib/account";
import { currentOrNextSession, nextSessionAfter, minutes } from "../lib/market/calendar";
import { getMarketSessions, tradingDateOf } from "../lib/market/sessions";
import type { Market } from "../lib/t212/instruments";
import { setRunStatus, researchAndDecide } from "./pipeline";
import { executeBuy } from "./execute";
import { executeExit } from "./exit";
import { scoreOutcomes } from "./outcomes";

const { runs, decisions, trades, equitySnapshots } = schema;

const MARKETS: Market[] = ["US", "UK"];
const TERMINAL_STATUSES = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

/** Injectable clock so the whole day can be simulated in tests. */
export interface SchedulerDeps {
  now: () => Date;
}
const realClock: SchedulerDeps = { now: () => new Date() };

const inFlight = new Set<string>();
const lastAttempt = new Map<string, number>();
const warnedAt = new Map<string, number>();

function guarded(key: string, fn: () => Promise<void>): void {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  fn()
    .catch((err) => log("error", "scheduler", `${key} crashed: ${String(err)}`))
    .finally(() => inFlight.delete(key));
}

function due(key: string, everyMs: number, now: number): boolean {
  if (now - (lastAttempt.get(key) ?? 0) < everyMs) return false;
  lastAttempt.set(key, now);
  return true;
}

function warnOnce(key: string, message: string, runId: number | undefined, now: number) {
  if (now - (warnedAt.get(key) ?? 0) < 30 * 60_000) return;
  warnedAt.set(key, now);
  log("warn", "scheduler", message, runId);
}

/** Create today's run for a market once we are inside its research window. */
async function ensureRun(market: Market, deps: SchedulerDeps): Promise<void> {
  const settings = getSettings();
  if (!settings.markets[market] || settings.killSwitch) return;
  const client = tryClient();
  if (!client) return;
  const now = deps.now();
  const db = getDb();

  // One position at a time: never open a second run while a trade is open.
  if (db.select({ id: trades.id }).from(trades).where(eq(trades.status, "open")).get()) return;

  const session = currentOrNextSession(await getMarketSessions(client, market), now);
  if (!session || now < session.open) return;
  const start = session.close.getTime() - minutes(settings.minutesBeforeCloseToResearch);
  const end = session.close.getTime() - minutes(settings.minutesBeforeCloseToBuy + 2);
  if (now.getTime() < start || now.getTime() >= end) return;

  const tradingDate = tradingDateOf(market, session.close);
  const existing = db.select({ id: runs.id }).from(runs).where(and(eq(runs.tradingDate, tradingDate), eq(runs.market, market))).get();
  if (existing) return;

  // Cross-market rule: once one market has produced a trade today, don't start the other.
  const sameDayTrade = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.tradingDate, tradingDate), inArray(runs.status, ["holding", "exiting", "executing"])))
    .get();
  if (sameDayTrade) return;

  const mode = currentMode(settings);
  const row = db
    .insert(runs)
    .values({ tradingDate, market, mode, status: "scheduled", sessionCloseAt: session.close })
    .returning({ id: runs.id })
    .get();
  log("info", "scheduler", `Created ${mode.toUpperCase()} run #${row.id} for ${market} ${tradingDate} (closes ${session.close.toISOString()})`, row.id);
}

async function processRun(run: typeof runs.$inferSelect, deps: SchedulerDeps): Promise<void> {
  const db = getDb();
  const settings = getSettings();
  const nowMs = deps.now().getTime();
  const closeMs = run.sessionCloseAt?.getTime() ?? 0;

  switch (run.status) {
    case "scheduled": {
      if (settings.killSwitch) return setRunStatus(run.id, "skipped", "Kill switch is on");
      guarded(`research:${run.id}`, () => researchAndDecide(run.id));
      return;
    }
    case "awaiting_approval": {
      const d = db.select().from(decisions).where(eq(decisions.runId, run.id)).orderBy(desc(decisions.id)).get();
      if (!d) return setRunStatus(run.id, "failed", "Decision missing");
      if (settings.killSwitch) {
        db.update(decisions).set({ approval: "rejected" }).where(eq(decisions.id, d.id)).run();
        return setRunStatus(run.id, "no_trade", "Kill switch is on");
      }
      if (d.approval === "approved") return setRunStatus(run.id, "ready_to_buy");
      if (d.approval === "rejected") return setRunStatus(run.id, "no_trade", "Rejected by you");
      if (d.approval === "pending" && d.approvalDeadline && nowMs >= d.approvalDeadline.getTime()) {
        db.update(decisions).set({ approval: "expired" }).where(eq(decisions.id, d.id)).run();
        log("info", "scheduler", "Approval window expired; no trade today.", run.id);
        return setRunStatus(run.id, "no_trade", "Approval window expired");
      }
      return;
    }
    case "ready_to_buy": {
      if (settings.killSwitch) return setRunStatus(run.id, "no_trade", "Kill switch is on");
      if (nowMs >= closeMs) return setRunStatus(run.id, "no_trade", "Missed the buy window");
      if (nowMs >= closeMs - minutes(settings.minutesBeforeCloseToBuy)) guarded(`buy:${run.id}`, () => executeBuy(run.id));
      return;
    }
    case "holding":
    case "exiting": {
      // Exits keep running under the kill switch: it stops new risk, it should not strand an open position.
      const client = tryClient();
      if (!client) return;
      const next = nextSessionAfter(await getMarketSessions(client, run.market), run.sessionCloseAt ?? deps.now());
      if (!next) return warnOnce(`nosession:${run.id}`, "Exit session not found in T212 schedule yet; waiting.", run.id, nowMs);
      if (run.mode === "dry") {
        if (nowMs >= next.open.getTime() + minutes(2) && due(`exit:${run.id}`, 60_000, nowMs)) guarded(`exit:${run.id}`, () => executeExit(run.id));
      } else if (nowMs >= next.open.getTime() - minutes(3) && due(`exit:${run.id}`, 10_000, nowMs)) {
        guarded(`exit:${run.id}`, () => executeExit(run.id));
      }
      return;
    }
  }
}

async function snapshotEquity(deps: SchedulerDeps): Promise<void> {
  const client = tryClient();
  const acct = await getAccountState(client);
  getDb().insert(equitySnapshots).values({ ts: deps.now(), totalValue: acct.totalValue, cash: acct.availableCash, mode: currentMode() }).run();
}

let ticking = false;

export async function tick(deps: SchedulerDeps = realClock): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const db = getDb();
    const nowMs = deps.now().getTime();
    db.insert(schema.settings).values({ key: "_heartbeat", value: nowMs }).onConflictDoUpdate({ target: schema.settings.key, set: { value: nowMs } }).run();

    for (const m of MARKETS) {
      try {
        await ensureRun(m, deps);
      } catch (err) {
        warnOnce(`ensure:${m}`, `Could not check ${m} schedule: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }

    const active = db.select().from(runs).where(notInArray(runs.status, [...TERMINAL_STATUSES])).all();
    for (const r of active) {
      try {
        await processRun(r, deps);
      } catch (err) {
        warnOnce(`run:${r.id}`, `Run #${r.id} step failed: ${String(err).slice(0, 200)}`, r.id, nowMs);
      }
    }

    if (due("equity", 15 * 60_000, nowMs)) guarded("equity", () => snapshotEquity(deps));
    if (due("outcomes", 60 * 60_000, nowMs)) guarded("outcomes", async () => void (await scoreOutcomes()));
  } finally {
    ticking = false;
  }
}
