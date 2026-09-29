/**
 * The knowledge base: what the model has worked out about individual symbols by studying them
 * continuously, instead of only in the minutes before a close.
 *
 * A study round writes price signals for every symbol it scans and full research for the best of
 * them. A run then reads from here, so by the time a decision is due most of the expensive work has
 * already been done and the shortlist can be judged against names with a track record rather than
 * whatever happened to screen well in the last few minutes.
 */

import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Market } from "../t212/instruments";
import type { Candidate } from "./screener";
import type { Research } from "./schemas";
import type { AnalogueSnapshot } from "./analogues";

const { knowledge } = schema;
export type KnowledgeRow = typeof knowledge.$inferSelect;
/** Research as stored: the normal shape plus the analogue snapshot the decision stage needs. */
export type StoredResearch = Research & { analogue?: AnalogueSnapshot | null };

/**
 * Record what a study round saw. The rolling mean is updated in SQL from the existing row so two
 * concurrent rounds cannot read-modify-write over each other, and `observations` only counts
 * rounds that actually produced a score.
 */
export async function recordObservations(cands: Candidate[]): Promise<void> {
  if (cands.length === 0) return;
  const db = getDb();
  const now = new Date();
  for (const c of cands) {
    await db
      .insert(knowledge)
      .values({
        symbol: c.yahoo,
        ticker: c.ticker,
        name: c.name,
        market: c.market,
        price: c.price,
        screenScore: c.score,
        avgScore: c.score,
        bestScore: c.score,
        observations: 1,
        signals: { ...c.signals } as KnowledgeRow["signals"],
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: knowledge.symbol,
        set: {
          ticker: c.ticker,
          name: c.name,
          market: c.market,
          price: c.price,
          screenScore: c.score,
          observations: sql`${knowledge.observations} + 1`,
          avgScore: sql`((coalesce(${knowledge.avgScore}, 0) * ${knowledge.observations}) + ${c.score}) / (${knowledge.observations} + 1)`,
          bestScore: sql`max(coalesce(${knowledge.bestScore}, ${c.score}), ${c.score})`,
          signals: { ...c.signals } as KnowledgeRow["signals"],
          updatedAt: now,
        },
      });
  }
}

export async function recordResearch(symbol: string, research: StoredResearch): Promise<void> {
  await getDb()
    .update(knowledge)
    .set({
      research,
      summary: research.summary,
      sentiment: research.sentiment,
      newsBurst: research.newsBurst,
      overnightRisk: research.overnightRisk,
      researchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(knowledge.symbol, symbol));
}

export async function getKnowledge(symbols: string[]): Promise<Map<string, KnowledgeRow>> {
  if (symbols.length === 0) return new Map();
  const rows = await getDb().select().from(knowledge).where(inArray(knowledge.symbol, symbols));
  return new Map(rows.map((r) => [r.symbol, r]));
}

/** Stored research, but only while it is still inside its freshness window. */
export function freshResearchOf(row: KnowledgeRow | undefined, ttlHours: number, now = Date.now()): StoredResearch | null {
  if (!row?.research || !row.researchedAt) return null;
  if (now - row.researchedAt.getTime() > ttlHours * 3_600_000) return null;
  return row.research as StoredResearch;
}

/**
 * Names the base rates highly and has seen often enough to believe. Used to give tonight's
 * shortlist a few extra slots for symbols with a record, rather than only today's best screens.
 */
export async function provenSymbols(market: Market, opts: { minObservations: number; limit: number; exclude?: Set<string> }): Promise<KnowledgeRow[]> {
  if (opts.limit <= 0) return [];
  const rows = await getDb()
    .select()
    .from(knowledge)
    .where(and(eq(knowledge.market, market), gte(knowledge.observations, opts.minObservations), isNotNull(knowledge.avgScore)))
    .orderBy(desc(knowledge.avgScore))
    .limit(opts.limit + (opts.exclude?.size ?? 0));
  return rows.filter((r) => !opts.exclude?.has(r.ticker)).slice(0, opts.limit);
}

/** Drop symbols the rotation has not seen for a long time so delistings do not accumulate. */
export async function pruneKnowledge(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await getDb().delete(knowledge).where(lt(knowledge.updatedAt, cutoff)).returning({ symbol: knowledge.symbol });
  return rows.length;
}

export interface KnowledgeStats {
  symbols: number;
  researched: number;
  studiedLastHour: number;
  lastStudiedAt: Date | null;
}

export async function knowledgeStats(): Promise<KnowledgeStats> {
  const db = getDb();
  const hourAgo = new Date(Date.now() - 3_600_000);
  const [agg] = await db
    .select({
      symbols: sql<number>`count(*)`,
      researched: sql<number>`sum(case when ${knowledge.researchedAt} is not null then 1 else 0 end)`,
      studiedLastHour: sql<number>`sum(case when ${knowledge.updatedAt} >= ${hourAgo.getTime()} then 1 else 0 end)`,
      lastStudiedAt: sql<number | null>`max(${knowledge.updatedAt})`,
    })
    .from(knowledge);
  return {
    symbols: Number(agg?.symbols ?? 0),
    researched: Number(agg?.researched ?? 0),
    studiedLastHour: Number(agg?.studiedLastHour ?? 0),
    lastStudiedAt: agg?.lastStudiedAt ? new Date(Number(agg.lastStudiedAt)) : null,
  };
}

/** The most recently studied names, for the activity feed. */
export async function recentlyStudied(limit = 12): Promise<KnowledgeRow[]> {
  return getDb().select().from(knowledge).orderBy(desc(knowledge.updatedAt)).limit(limit);
}

/** The best of what the base currently knows, for the activity feed and the chat assistant. */
export async function bestKnown(limit = 8): Promise<KnowledgeRow[]> {
  return getDb().select().from(knowledge).where(isNotNull(knowledge.avgScore)).orderBy(desc(knowledge.avgScore)).limit(limit);
}
