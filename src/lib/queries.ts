import { and, asc, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnvConfig, getSettings } from "./config";
import { getAccountState, pnlWindows, tryClient, type AccountState } from "./account";
import { getActiveLessons, getPerformanceStats } from "./ai/memory";

const { runs, decisions, trades, candidates, orders, equitySnapshots, eventLog, lessons } = schema;

export const TERMINAL = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

export type RunRow = typeof runs.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;

export function getWorkerStatus() {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, "_heartbeat")).get();
  const last = typeof row?.value === "number" ? row.value : null;
  return { lastHeartbeat: last, alive: last != null && Date.now() - last < 90_000 };
}

export function getEnvStatus() {
  const e = getEnvConfig();
  return { t212Env: e.t212Env, hasT212Keys: !!(e.t212Key && e.t212Secret), hasOpenAI: !!e.openaiKey, model: e.openaiModel };
}

export async function getAccountSafe(): Promise<{ account: AccountState | null; error?: string }> {
  try {
    return { account: await getAccountState(tryClient()) };
  } catch (err) {
    return { account: null, error: String(err).slice(0, 200) };
  }
}

/** The run to feature on the dashboard: the live one, else the most recent. */
export function getFeaturedRun() {
  const db = getDb();
  const active = db.select().from(runs).where(notInArray(runs.status, [...TERMINAL])).orderBy(desc(runs.id)).get();
  const run = active ?? db.select().from(runs).orderBy(desc(runs.id)).get() ?? null;
  if (!run) return null;
  const decision = db.select().from(decisions).where(eq(decisions.runId, run.id)).orderBy(desc(decisions.id)).get() ?? null;
  const trade = db.select().from(trades).where(eq(trades.runId, run.id)).get() ?? null;
  return { run, decision, trade };
}

export function getOpenTrade() {
  const t = getDb().select().from(trades).where(eq(trades.status, "open")).get();
  if (!t) return null;
  const decision = getDb().select().from(decisions).where(eq(decisions.id, t.decisionId)).get() ?? null;
  return { trade: t, decision };
}

export function getEquitySeries(limit = 600) {
  return getDb().select().from(equitySnapshots).orderBy(desc(equitySnapshots.ts)).limit(limit).all().reverse();
}

export function getRecentEvents(limit = 25) {
  return getDb().select().from(eventLog).orderBy(desc(eventLog.id)).limit(limit).all();
}

export function getUnknownOrders() {
  return getDb().select().from(orders).where(eq(orders.status, "unknown")).all();
}

export function getPnlWindows(total: number) {
  return pnlWindows(total);
}

export function getHistory(limit = 100) {
  return getDb()
    .select({ run: runs, decision: decisions, trade: trades })
    .from(runs)
    .leftJoin(decisions, eq(decisions.runId, runs.id))
    .leftJoin(trades, eq(trades.runId, runs.id))
    .orderBy(desc(runs.id))
    .limit(limit)
    .all();
}

export function getRunDetail(runId: number) {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;
  return {
    run,
    decision: db.select().from(decisions).where(eq(decisions.runId, runId)).orderBy(desc(decisions.id)).get() ?? null,
    trade: db.select().from(trades).where(eq(trades.runId, runId)).get() ?? null,
    candidates: db.select().from(candidates).where(eq(candidates.runId, runId)).orderBy(desc(candidates.screenScore)).all(),
    orders: db.select().from(orders).where(eq(orders.runId, runId)).orderBy(asc(orders.id)).all(),
    events: db.select().from(eventLog).where(eq(eventLog.runId, runId)).orderBy(asc(eventLog.id)).all(),
    lessons: db
      .select({ l: lessons })
      .from(lessons)
      .innerJoin(trades, eq(lessons.tradeId, trades.id))
      .where(eq(trades.runId, runId))
      .all()
      .map((x) => x.l),
  };
}

export function getLearning() {
  const db = getDb();
  const stats = getPerformanceStats();
  const closed = db
    .select({ date: runs.tradingDate, ticker: trades.ticker, pnlPct: trades.pnlPct, confidence: decisions.confidence, expected: decisions.expectedMovePct })
    .from(trades)
    .innerJoin(decisions, eq(trades.decisionId, decisions.id))
    .innerJoin(runs, eq(trades.runId, runs.id))
    .where(and(eq(trades.status, "closed"), isNotNull(trades.pnlPct)))
    .orderBy(asc(trades.exitAt))
    .all();
  const scored = db
    .select({ ticker: candidates.ticker, picked: candidates.picked, ret: candidates.overnightReturnPct, date: runs.tradingDate, market: runs.market })
    .from(candidates)
    .innerJoin(runs, eq(candidates.runId, runs.id))
    .where(isNotNull(candidates.overnightReturnPct))
    .orderBy(desc(candidates.id))
    .all();
  const noTradeDays = db.select({ id: runs.id }).from(runs).where(inArray(runs.status, ["no_trade", "blocked"])).all().length;
  return { stats, closed, scored, lessons: getActiveLessons(100), noTradeDays };
}

export function getSettingsView() {
  return { settings: getSettings(), env: getEnvStatus() };
}
