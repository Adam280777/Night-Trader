import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "../db";

const { trades, decisions, lessons, candidates, runs } = schema;

export interface PerfStats {
  closedTrades: number;
  winRate: number | null;
  avgPnlPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  totalPnl: number;
  byConfidence: { bucket: string; n: number; winRate: number; avgPnlPct: number }[];
  byMarket: { market: string; n: number; winRate: number; avgPnlPct: number }[];
  /** Overnight return of the shortlist as a whole vs what we picked: is the AI adding value over the screener? */
  shortlistAvgOvernightPct: number | null;
  pickedAvgOvernightPct: number | null;
  recent: { date: string; ticker: string; pnlPct: number | null; confidence: number | null }[];
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export async function getPerformanceStats(): Promise<PerfStats> {
  const db = getDb();
  const rows = await db
    .select({
      pnl: trades.pnl,
      pnlPct: trades.pnlPct,
      ticker: trades.ticker,
      exitAt: trades.exitAt,
      confidence: decisions.confidence,
      market: runs.market,
      date: runs.tradingDate,
    })
    .from(trades)
    .innerJoin(decisions, eq(trades.decisionId, decisions.id))
    .innerJoin(runs, eq(trades.runId, runs.id))
    .where(and(eq(trades.status, "closed"), isNotNull(trades.pnlPct)))
    .orderBy(desc(trades.exitAt));

  const pcts = rows.map((r) => r.pnlPct!);
  const wins = pcts.filter((p) => p > 0);
  const losses = pcts.filter((p) => p <= 0);

  const group = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, number[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.pnlPct!]);
    return [...m.entries()].map(([k, v]) => ({
      key: k,
      n: v.length,
      winRate: v.filter((x) => x > 0).length / v.length,
      avgPnlPct: avg(v)!,
    }));
  };

  const bucket = (c: number | null) => (c == null ? "unknown" : c >= 0.8 ? "80-100%" : c >= 0.65 ? "65-80%" : "<65%");

  const cand = await db
    .select({ r: candidates.overnightReturnPct, picked: candidates.picked })
    .from(candidates)
    .where(isNotNull(candidates.overnightReturnPct));

  return {
    closedTrades: rows.length,
    winRate: rows.length ? wins.length / rows.length : null,
    avgPnlPct: avg(pcts),
    avgWinPct: avg(wins),
    avgLossPct: avg(losses),
    totalPnl: rows.reduce((s, r) => s + (r.pnl ?? 0), 0),
    byConfidence: group((r) => bucket(r.confidence)).map((g) => ({ bucket: g.key, ...omitKey(g) })),
    byMarket: group((r) => r.market).map((g) => ({ market: g.key, ...omitKey(g) })),
    shortlistAvgOvernightPct: avg(cand.map((c) => c.r!)),
    pickedAvgOvernightPct: avg(cand.filter((c) => c.picked).map((c) => c.r!)),
    recent: rows.slice(0, 10).map((r) => ({ date: r.date, ticker: r.ticker, pnlPct: r.pnlPct, confidence: r.confidence })),
  };
}

function omitKey<T extends { key: string }>(g: T) {
  const { key: _k, ...rest } = g;
  return rest;
}

/** Newest active lessons first. With few lessons we include all; the meta-review job keeps the set small. */
export async function getActiveLessons(limit = 25) {
  return getDb().select().from(lessons).where(eq(lessons.active, true)).orderBy(desc(lessons.createdAt)).limit(limit);
}

export function formatMemoryForPrompt(stats: PerfStats, ls: { text: string; tags: string[] }[]): string {
  const pct = (x: number | null) => (x == null ? "n/a" : `${x.toFixed(2)}%`);
  const lines: string[] = ["## Your track record"];
  if (stats.closedTrades === 0) {
    lines.push("No closed trades yet. Be conservative: NO_TRADE is a good answer when the edge is unclear.");
  } else {
    lines.push(
      `Closed trades: ${stats.closedTrades}, win rate ${((stats.winRate ?? 0) * 100).toFixed(0)}%, avg ${pct(stats.avgPnlPct)} (wins ${pct(stats.avgWinPct)}, losses ${pct(stats.avgLossPct)}), total P&L ${stats.totalPnl.toFixed(2)}.`,
    );
    for (const b of stats.byConfidence) lines.push(`- Confidence ${b.bucket}: ${b.n} trades, win ${(b.winRate * 100).toFixed(0)}%, avg ${pct(b.avgPnlPct)}`);
    for (const m of stats.byMarket) lines.push(`- ${m.market}: ${m.n} trades, win ${(m.winRate * 100).toFixed(0)}%, avg ${pct(m.avgPnlPct)}`);
    if (stats.shortlistAvgOvernightPct != null && stats.pickedAvgOvernightPct != null) {
      lines.push(
        `Shortlist average overnight return ${pct(stats.shortlistAvgOvernightPct)} vs your picks ${pct(stats.pickedAvgOvernightPct)} (are you beating the screener?).`,
      );
    }
    lines.push("Last trades: " + stats.recent.map((r) => `${r.date} ${r.ticker} ${pct(r.pnlPct)}`).join("; "));
  }
  lines.push("", "## Lessons you wrote after past trades");
  if (ls.length === 0) lines.push("(none yet)");
  for (const l of ls) lines.push(`- ${l.text}${l.tags.length ? ` [${l.tags.join(", ")}]` : ""}`);
  return lines.join("\n");
}
