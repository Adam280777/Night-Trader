import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnvConfig, getSettings } from "./config";
import { getDashboardAccountState, pnlWindows, tryClient, type AccountState } from "./account";
import { getActiveLessons, getPerformanceStats } from "./quant/memory";
import { getModelReport } from "./quant/learn";
import { strategyRisk } from "./quant/evaluation";

const { runs, decisions, trades, candidates, orders, equitySnapshots, eventLog, lessons } = schema;

export const TERMINAL = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

export type RunRow = typeof runs.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;

/** The cloud scheduler is "alive" if an external timer has called the tick endpoint recently. */
export async function getWorkerStatus(staleMinutes = 4) {
  const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "_heartbeat"));
  const last = typeof row?.value === "number" ? row.value : null;
  return { lastHeartbeat: last, alive: last != null && Date.now() - last < staleMinutes * 60_000 };
}

export async function getEnvStatus() {
  const e = await getEnvConfig();
  return { t212Env: e.t212Env, hasT212Keys: !!(e.t212Key && e.t212Secret) };
}

export async function getAccountSafe(): Promise<{ account: AccountState | null; error?: string }> {
  try {
    return { account: await getDashboardAccountState(await tryClient()) };
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
      .where(and(eq(trades.status, "closed"), isNotNull(trades.pnlPct), eq(runs.strategy, "overnight")))
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
  return { stats, closed, scored, lessons: active, noTradeDays: noTrade.length, model, risk: strategyRisk(closed.map((row) => row.pnlPct ?? NaN)) };
}

export async function getSettingsView() {
  const [settings, env] = await Promise.all([getSettings(), getEnvStatus()]);
  return { settings, env };
}

export async function getDashboardInsights(limit = 180) {
  const rows = await getDb()
    .select({
      id: runs.id,
      date: runs.tradingDate,
      status: runs.status,
      strategy: runs.strategy,
      market: runs.market,
      pnlPct: trades.pnlPct,
    })
    .from(runs)
    .leftJoin(trades, eq(trades.runId, runs.id))
    .orderBy(desc(runs.id))
    .limit(limit);

  const status = new Map<string, number>();
  const strategies = new Map<string, { runs: number; trades: number; pnlPct: number; wins: number }>();
  for (const row of rows) status.set(row.status, (status.get(row.status) ?? 0) + 1);
  for (const row of rows) {
    const current = strategies.get(row.strategy) ?? { runs: 0, trades: 0, pnlPct: 0, wins: 0 };
    current.runs++;
    if (row.pnlPct != null) {
      current.trades++;
      current.pnlPct += row.pnlPct;
      if (row.pnlPct > 0) current.wins++;
    }
    strategies.set(row.strategy, current);
  }
  return {
    statuses: [...status].map(([label, value]) => ({ label: label.replaceAll("_", " "), value })),
    returns: rows
      .filter((row) => row.pnlPct != null)
      .map((row) => ({ date: row.date, value: row.pnlPct!, label: `${row.market} run #${row.id}` })),
    totalRuns: rows.length,
    strategies: [...strategies].map(([strategy, value]) => ({
      strategy,
      ...value,
      averageReturnPct: value.trades ? value.pnlPct / value.trades : null,
      winRate: value.trades ? value.wins / value.trades : null,
    })),
  };
}

export async function getSystemDiagnostics() {
  const db = getDb();
  const [settings, jobs, counts, recentLevels, executionOrders] = await Promise.all([
    getSettings(),
    db.select().from(schema.jobRuns).orderBy(desc(schema.jobRuns.id)).limit(500),
    Promise.all(
      [
        ["runs", runs],
        ["decisions", decisions],
        ["trades", trades],
        ["candidates", candidates],
        ["orders", orders],
        ["logs", eventLog],
        ["equity snapshots", equitySnapshots],
        ["job records", schema.jobRuns],
        ["lessons", lessons],
      ] as const,
    ).then((tables) =>
      Promise.all(
        tables.map(async ([label, table]) => {
          const [row] = await db.select({ n: sql<number>`count(*)` }).from(table);
          return { label, value: Number(row.n) };
        }),
      ),
    ),
    db
      .select({ level: eventLog.level, n: sql<number>`count(*)` })
      .from(eventLog)
      .where(sql`${eventLog.ts} >= ${new Date(Date.now() - 24 * 60 * 60_000)}`)
      .groupBy(eventLog.level),
    db.select().from(orders).orderBy(desc(orders.id)).limit(200),
  ]);

  const latest = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) if (!latest.has(job.job)) latest.set(job.job, job);
  const failures = jobs.filter((job) => !job.ok);
  const completed = jobs.filter((job) => job.ok);
  const slippage = executionOrders.map((order) => order.slippagePct).filter((value): value is number => value != null && Number.isFinite(value));
  const spreads = executionOrders.map((order) => order.spreadPct).filter((value): value is number => value != null && Number.isFinite(value));
  const orderedSlippage = [...slippage].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(orderedSlippage.length * 0.95) - 1);
  const terminalOrders = executionOrders.filter((order) => ["filled", "partial", "rejected", "cancelled", "unknown"].includes(order.status));
  const problematicOrders = terminalOrders.filter((order) => order.status !== "filled");

  return {
    settings,
    jobs: [...jobs].reverse(),
    latest: [...latest.values()].sort((a, b) => a.job.localeCompare(b.job)),
    counts,
    levelCounts: recentLevels.map((row) => ({ label: row.level, value: Number(row.n) })),
    successRate: jobs.length ? completed.length / jobs.length : null,
    failures: failures.length,
    averageDurationMs: completed.length ? completed.reduce((sum, job) => sum + job.durationMs, 0) / completed.length : null,
    execution: {
      orders: executionOrders.length,
      measuredFills: slippage.length,
      averageSlippagePct: slippage.length ? slippage.reduce((sum, value) => sum + value, 0) / slippage.length : null,
      p95SlippagePct: orderedSlippage.length ? orderedSlippage[p95Index] : null,
      averageSpreadPct: spreads.length ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length : null,
      issueRate: terminalOrders.length ? problematicOrders.length / terminalOrders.length : null,
      rejected: executionOrders.filter((order) => order.status === "rejected").length,
      unknown: executionOrders.filter((order) => order.status === "unknown").length,
      partial: executionOrders.filter((order) => order.status === "partial").length,
      cancelled: executionOrders.filter((order) => order.status === "cancelled").length,
    },
    alerting: {
      webhookConfigured: !!process.env.ALERT_WEBHOOK_URL?.trim(),
      healthProtected: !!process.env.HEALTH_SECRET?.trim(),
    },
  };
}
