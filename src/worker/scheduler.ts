import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { currentMode, getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { withLock } from "../lib/locks";
import { getAccountState, tryClient } from "../lib/account";
import { currentOrNextSession, nextSessionAfter, minutes } from "../lib/market/calendar";
import { getMarketSessions, tradingDateOf } from "../lib/market/sessions";
import type { Market } from "../lib/t212/instruments";
import { setRunStatus, stageDecide, stageResearch, stageScreen } from "./pipeline";
import { executeBuy } from "./execute";
import { executeExit } from "./exit";
import { scoreOutcomes } from "./outcomes";

const { runs, decisions, trades, equitySnapshots, orders, candidates } = schema;

const MARKETS: Market[] = ["US", "UK"];
const TERMINAL_STATUSES = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

/** Injectable clock so the whole day can be simulated in tests. */
export interface SchedulerDeps {
  now: () => Date;
}
const realClock: SchedulerDeps = { now: () => new Date() };

/** One tick may use at most this long (Vercel's function limit is 300s). */
export const TICK_BUDGET_MS = 270_000;
/** Don't start new research calls after this point in a tick; a call can take ~90s. */
const RESEARCH_CUTOFF_MS = 160_000;
/** Don't begin the (slow) decision call with less than this left in the tick. */
const DECIDE_MIN_REMAINING_MS = 110_000;

export interface TickResult {
  ran: boolean;
  skipped?: string;
  activeRuns?: number;
}

async function warnOnce(key: string, message: string, runId: number | undefined, nowMs: number) {
  const k = await getKv<number>(`warn:${key}`);
  if (k && nowMs - k.value < 30 * 60_000) return;
  await setKv(`warn:${key}`, nowMs);
  await log("warn", "scheduler", message, runId);
}

async function every(name: string, everyMs: number, nowMs: number): Promise<boolean> {
  const last = await getKv<number>(`t:${name}`);
  if (last && nowMs - last.value < everyMs) return false;
  await setKv(`t:${name}`, nowMs);
  return true;
}

/**
 * Only one tick runs at a time (DB lease), so anything still "in progress" when a tick starts was
 * left behind by a tick that died. Repair it before doing anything else.
 */
async function recover(nowMs: number): Promise<void> {
  const db = getDb();

  // An order intent with no T212 id might or might not have reached the broker: never guess, never resend.
  const stale = await db.select().from(orders).where(eq(orders.status, "intent"));
  for (const o of stale) {
    await db.update(orders).set({ status: "unknown", error: "The scheduler stopped before the order call returned", updatedAt: new Date() }).where(eq(orders.id, o.id));
    await log("error", "recovery", `Order #${o.id} (${o.side} ${o.ticker}) has an unknown outcome. Check Trading 212, then resolve it in the app.`, o.runId ?? undefined);
  }

  const interrupted = await db.select().from(runs).where(eq(runs.status, "screening"));
  for (const r of interrupted) {
    const minsLeft = ((r.sessionCloseAt?.getTime() ?? 0) - nowMs) / 60_000;
    if (minsLeft > 15) {
      await db.delete(candidates).where(eq(candidates.runId, r.id));
      await setRunStatus(r.id, "scheduled");
      await log("info", "recovery", `Run #${r.id} screening was interrupted; restarting it (${Math.round(minsLeft)} min to close).`, r.id);
    } else {
      await setRunStatus(r.id, "failed", "Interrupted too close to the close");
    }
  }

  // Died mid-buy: trust the broker's position list.
  const executing = await db.select().from(runs).where(eq(runs.status, "executing"));
  if (executing.length === 0) return;
  const client = await tryClient();
  for (const r of executing) {
    const [d] = await db.select().from(decisions).where(eq(decisions.runId, r.id)).orderBy(desc(decisions.id)).limit(1);
    const [hasTrade] = await db.select().from(trades).where(eq(trades.runId, r.id)).limit(1);
    if (hasTrade) {
      await setRunStatus(r.id, "holding");
      continue;
    }
    if (r.mode !== "dry" && client && d?.ticker) {
      const pos = (await client.getPositions(d.ticker)).find((p) => p.instrument.ticker === d.ticker);
      if (pos && pos.quantity > 0) {
        await db
          .insert(trades)
          .values({ runId: r.id, decisionId: d.id, ticker: d.ticker, name: d.name, quantity: pos.quantity, entryPrice: pos.averagePricePaid, entryAt: new Date(), status: "open" });
        await setRunStatus(r.id, "holding");
        await log("warn", "recovery", `Recovered open position ${pos.quantity} ${d.ticker} for run #${r.id}.`, r.id);
        continue;
      }
    }
    await setRunStatus(r.id, "failed", "Interrupted during buy; no position found");
  }
}

/** Create today's run for a market once we are inside its research window. */
async function ensureRun(market: Market, deps: SchedulerDeps): Promise<void> {
  const settings = await getSettings();
  if (!settings.markets[market] || settings.killSwitch) return;
  const client = await tryClient();
  if (!client) return;
  const now = deps.now();
  const db = getDb();

  // One position at a time: never open a second run while a trade is open.
  const [openTrade] = await db.select({ id: trades.id }).from(trades).where(eq(trades.status, "open")).limit(1);
  if (openTrade) return;

  const session = currentOrNextSession(await getMarketSessions(client, market), now);
  if (!session || now < session.open) return;
  const start = session.close.getTime() - minutes(settings.minutesBeforeCloseToResearch);
  const end = session.close.getTime() - minutes(settings.minutesBeforeCloseToBuy + 2);
  if (now.getTime() < start || now.getTime() >= end) return;

  const tradingDate = tradingDateOf(market, session.close);
  const [existing] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.tradingDate, tradingDate), eq(runs.market, market))).limit(1);
  if (existing) return;

  // Cross-market rule: once one market has produced a trade today, don't start the other.
  const [sameDayTrade] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.tradingDate, tradingDate), inArray(runs.status, ["holding", "exiting", "executing"])))
    .limit(1);
  if (sameDayTrade) return;

  const mode = await currentMode(settings);
  const [row] = await db
    .insert(runs)
    .values({ tradingDate, market, mode, status: "scheduled", sessionCloseAt: session.close })
    .returning({ id: runs.id });
  await log("info", "scheduler", `Created ${mode.toUpperCase()} run #${row.id} for ${market} ${tradingDate} (closes ${session.close.toISOString()})`, row.id);
}

async function processRun(run: typeof runs.$inferSelect, deps: SchedulerDeps, startedAt: number): Promise<void> {
  const db = getDb();
  const settings = await getSettings();
  const nowMs = deps.now().getTime();
  const closeMs = run.sessionCloseAt?.getTime() ?? 0;
  const remaining = () => TICK_BUDGET_MS - (Date.now() - startedAt);

  switch (run.status) {
    case "scheduled":
    case "researching":
    case "deciding": {
      if (settings.killSwitch) return setRunStatus(run.id, "skipped", "Kill switch is on");
      if (nowMs >= closeMs - minutes(2)) return setRunStatus(run.id, "failed", "Ran out of time before the close");
      if (run.status === "scheduled") return stageScreen(run.id);
      if (run.status === "researching") return stageResearch(run.id, startedAt + RESEARCH_CUTOFF_MS);
      if (remaining() < DECIDE_MIN_REMAINING_MS) return; // let the next tick start it fresh
      return stageDecide(run.id);
    }
    case "awaiting_approval": {
      const [d] = await db.select().from(decisions).where(eq(decisions.runId, run.id)).orderBy(desc(decisions.id)).limit(1);
      if (!d) return setRunStatus(run.id, "failed", "Decision missing");
      if (settings.killSwitch) {
        await db.update(decisions).set({ approval: "rejected" }).where(eq(decisions.id, d.id));
        return setRunStatus(run.id, "no_trade", "Kill switch is on");
      }
      if (d.approval === "approved") return setRunStatus(run.id, "ready_to_buy");
      if (d.approval === "rejected") return setRunStatus(run.id, "no_trade", "Rejected by you");
      if (d.approval === "pending" && d.approvalDeadline && nowMs >= d.approvalDeadline.getTime()) {
        await db.update(decisions).set({ approval: "expired" }).where(eq(decisions.id, d.id));
        await log("info", "scheduler", "Approval window expired; no trade today.", run.id);
        return setRunStatus(run.id, "no_trade", "Approval window expired");
      }
      return;
    }
    case "ready_to_buy": {
      if (settings.killSwitch) return setRunStatus(run.id, "no_trade", "Kill switch is on");
      if (nowMs >= closeMs) return setRunStatus(run.id, "no_trade", "Missed the buy window");
      if (nowMs >= closeMs - minutes(settings.minutesBeforeCloseToBuy)) await executeBuy(run.id);
      return;
    }
    case "holding":
    case "exiting": {
      // Exits keep running under the kill switch: it stops new risk, it should not strand an open position.
      const client = await tryClient();
      if (!client) return;
      const next = nextSessionAfter(await getMarketSessions(client, run.market), run.sessionCloseAt ?? deps.now());
      if (!next) return warnOnce(`nosession:${run.id}`, "Exit session not found in T212 schedule yet; waiting.", run.id, nowMs);
      const exitFrom = run.mode === "dry" ? next.open.getTime() + minutes(2) : next.open.getTime() - minutes(3);
      if (nowMs >= exitFrom) await executeExit(run.id);
      return;
    }
  }
}

const PRIORITY: Record<string, number> = { holding: 0, exiting: 0, ready_to_buy: 1, awaiting_approval: 2 };

async function snapshotEquity(deps: SchedulerDeps): Promise<void> {
  const acct = await getAccountState(await tryClient());
  await getDb().insert(equitySnapshots).values({ ts: deps.now(), totalValue: acct.totalValue, cash: acct.availableCash, mode: await currentMode() });
}

/** One scheduler pass. Called about once a minute by an external timer; safe to call concurrently (DB lease). */
export async function tick(deps: SchedulerDeps = realClock): Promise<TickResult> {
  const startedAt = Date.now();
  let result: TickResult = { ran: false, skipped: "another tick is running" };
  const got = await withLock("tick", TICK_BUDGET_MS + 60_000, async () => {
    const db = getDb();
    const nowMs = deps.now().getTime();
    await db.insert(schema.settings).values({ key: "_heartbeat", value: nowMs }).onConflictDoUpdate({ target: schema.settings.key, set: { value: nowMs } });

    await recover(nowMs);

    for (const m of MARKETS) {
      try {
        await ensureRun(m, deps);
      } catch (err) {
        await warnOnce(`ensure:${m}`, `Could not check ${m} schedule: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }

    const active = (await db.select().from(runs).where(notInArray(runs.status, [...TERMINAL_STATUSES]))).sort(
      (a, b) => (PRIORITY[a.status] ?? 3) - (PRIORITY[b.status] ?? 3),
    );
    for (const r of active) {
      try {
        await processRun(r, deps, startedAt);
      } catch (err) {
        await warnOnce(`run:${r.id}`, `Run #${r.id} step failed: ${String(err).slice(0, 200)}`, r.id, nowMs);
      }
    }

    if (Date.now() - startedAt < TICK_BUDGET_MS - 60_000) {
      try {
        if (await every("equity", 15 * 60_000, nowMs)) await snapshotEquity(deps);
        if (await every("outcomes", 60 * 60_000, nowMs)) await scoreOutcomes();
      } catch (err) {
        await warnOnce("housekeeping", `Housekeeping failed: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }
    result = { ran: true, activeRuns: active.length };
  });
  return got ? result : { ran: false, skipped: "another tick is running" };
}
