import { and, asc, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnvConfig, getSettings } from "./config";
import { getAccountState, pnlWindows, tryClient, type AccountState } from "./account";
import { getActiveLessons, getPerformanceStats } from "./quant/memory";
import { getModelReport } from "./quant/learn";

const { runs, decisions, trades, candidates, orders, equitySnapshots, eventLog, lessons } = schema;

export const TERMINAL = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

export type RunRow = typeof runs.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;

/** The cloud scheduler is "alive" if an external timer has called the tick endpoint recently. */
export async function getWorkerStatus() {
  const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "_heartbeat"));
  const last = typeof row?.value === "number" ? row.value : null;
  return { lastHeartbeat: last, alive: last != null && Date.now() - last < 4 * 60_000 };
}

export async function getEnvStatus() {
  const e = await getEnvConfig();
  return { t212Env: e.t212Env, hasT212Keys: !!(e.t212Key && e.t212Secret) };
}

export async function getAccountSafe(): Promise<{ account: AccountState | null; error?: string }> {
  try {
    return { account: await getAccountState(await tryClient()) };
  } catch (err) {
    return { account: null, error: String(err).slice(0, 200) };
  }
}

/** The run to feature on the dashboard: the live one, else the most recent. */
export async function getFeaturedRun() {
  const db = getDb();
  const [active] = await db.select().from(runs).where(notInArray(runs.status, [...TERMINAL])).orderBy(desc(runs.id)).limit(1);
  const run = active ?? (await db.select().from(runs).orderBy(desc(runs.id)).limit(1))[0] ?? null;
  if (!run) return null;
  const [decision] = await db.select().from(decisions).where(eq(decisions.runId, run.id)).orderBy(desc(decisions.id)).limit(1);
  const [trade] = await db.select().from(trades).where(eq(trades.runId, run.id)).limit(1);
  return { run, decision: decision ?? null, trade: trade ?? null };
}

export async function getOpenTrade() {
  const db = getDb();
  const [t] = await db.select().from(trades).where(eq(trades.status, "open")).limit(1);
  if (!t) return null;
  const [decision] = await db.select().from(decisions).where(eq(decisions.id, t.decisionId)).limit(1);
  return { trade: t, decision: decision ?? null };
}

export async function getEquitySeries(limit = 600) {
  const rows = await getDb().select().from(equitySnapshots).orderBy(desc(equitySnapshots.ts)).limit(limit);
  return rows.reverse();
}

export async function getRecentEvents(limit = 25) {
  return getDb().select().from(eventLog).orderBy(desc(eventLog.id)).limit(limit);
}

export async function getUnknownOrders() {
  return getDb().select().from(orders).where(eq(orders.status, "unknown"));
}

export async function getPnlWindows(total: number) {
  return pnlWindows(total);
}

export async function getHistory(limit = 100) {
  return getDb()
    .select({ run: runs, decision: decisions, trade: trades })
    .from(runs)
    .leftJoin(decisions, eq(decisions.runId, runs.id))
    .leftJoin(trades, eq(trades.runId, runs.id))
    .orderBy(desc(runs.id))
    .limit(limit);
}

export async function getRunDetail(runId: number) {
  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return null;
  const [decision] = await db.select().from(decisions).where(eq(decisions.runId, runId)).orderBy(desc(decisions.id)).limit(1);
  const [trade] = await db.select().from(trades).where(eq(trades.runId, runId)).limit(1);
  const [cands, ords, events, lessonRows] = await Promise.all([
    db.select().from(candidates).where(eq(candidates.runId, runId)).orderBy(desc(candidates.screenScore)),
    db.select().from(orders).where(eq(orders.runId, runId)).orderBy(asc(orders.id)),
    db.select().from(eventLog).where(eq(eventLog.runId, runId)).orderBy(asc(eventLog.id)),
    db.select({ l: lessons }).from(lessons).innerJoin(trades, eq(lessons.tradeId, trades.id)).where(eq(trades.runId, runId)),
  ]);
  return { run, decision: decision ?? null, trade: trade ?? null, candidates: cands, orders: ords, events, lessons: lessonRows.map((x) => x.l) };
}

export async function getLearning() {
  const db = getDb();
  const [stats, closed, scored, noTrade, active, model] = await Promise.all([
    getPerformanceStats(),
    db
      .select({ date: runs.tradingDate, ticker: trades.ticker, pnlPct: trades.pnlPct, confidence: decisions.confidence, expected: decisions.expectedMovePct })
      .from(trades)
      .innerJoin(decisions, eq(trades.decisionId, decisions.id))
      .innerJoin(runs, eq(trades.runId, runs.id))
      .where(and(eq(trades.status, "closed"), isNotNull(trades.pnlPct)))
      .orderBy(asc(trades.exitAt)),
    db
      .select({ ticker: candidates.ticker, picked: candidates.picked, ret: candidates.overnightReturnPct, date: runs.tradingDate, market: runs.market })
      .from(candidates)
      .innerJoin(runs, eq(candidates.runId, runs.id))
      .where(isNotNull(candidates.overnightReturnPct))
      .orderBy(desc(candidates.id)),
    db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ["no_trade", "blocked"])),
    getActiveLessons(100),
    getModelReport(),
  ]);
  return { stats, closed, scored, lessons: active, noTradeDays: noTrade.length, model };
}

export async function getSettingsView() {
  const [settings, env] = await Promise.all([getSettings(), getEnvStatus()]);
  return { settings, env };
}
