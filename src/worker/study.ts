/**
 * Continuous study.
 *
 * The trading run still happens in the minutes before a close, but research no longer waits for it.
 * Every spare moment in a tick, this works through the tradable universe a slice at a time, scores
 * what it finds and reads the headlines of the most promising names, storing everything in the
 * knowledge base. By the time a decision is due the model is choosing between names it has already
 * been watching for hours rather than ones it met a minute ago.
 *
 * It only ever runs on time left over after live trading work, so studying can never delay a trade.
 */

import { inArray, lt } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { tryClient } from "../lib/account";
import { getInstrumentsCached, type Market } from "../lib/t212/instruments";
import { attachEarnings, scoreSymbols, universeOf, type Candidate, type SymbolRef } from "../lib/quant/screener";
import { researchCandidate } from "../lib/quant/research";
import { getKnowledge, pruneKnowledge, purgeOutsideUniverse, recordObservations, recordResearch } from "../lib/quant/knowledge";
import type { QuantTuning } from "../lib/quant/tuning";
import { nextOpenWeekday } from "./pipeline";

export interface StudyResult {
  ran: boolean;
  skipped?: string;
  market?: Market;
  scanned?: number;
  scored?: number;
  researched?: number;
  /** Names passed over because an earlier lap found them unusable. */
  skippedKnown?: number;
}

const TARGET_LIQUID_PER_ROUND = 24;
const MAX_SCAN_PER_ROUND = 300;
/** History is fetched per name, so cap it even when a lucky slice is mostly liquid. */
const MAX_SCORED_PER_ROUND = 40;

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Where the rotation reached last time, so successive rounds cover the whole universe. */
async function cursorFor(market: Market): Promise<number> {
  return (await getKv<number>(`study:cursor:${market}`))?.value ?? 0;
}

/** Alternate markets between rounds so neither is starved while both are enabled. */
async function pickMarket(enabled: Market[]): Promise<Market> {
  const last = (await getKv<Market>("study:market"))?.value;
  const i = last ? enabled.indexOf(last) : -1;
  const next = enabled[(i + 1) % enabled.length];
  await setKv("study:market", next);
  return next;
}

/** Which of these symbols a recent lap already found unusable. */
async function activeSkips(symbols: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const now = Date.now();
  for (let i = 0; i < symbols.length; i += 400) {
    const rows = await getDb()
      .select({ symbol: schema.studySkips.symbol, until: schema.studySkips.until })
      .from(schema.studySkips)
      .where(inArray(schema.studySkips.symbol, symbols.slice(i, i + 400)));
    for (const r of rows) if (r.until.getTime() > now) out.add(r.symbol);
  }
  return out;
}

async function recordSkips(market: Market, dropped: Map<string, string>, retestDays: number): Promise<void> {
  const until = new Date(Date.now() + retestDays * 86_400_000);
  for (const [symbol, reason] of dropped) {
    await getDb()
      .insert(schema.studySkips)
      .values({ symbol, market, reason, until })
      .onConflictDoUpdate({ target: schema.studySkips.symbol, set: { market, reason, until } });
  }
}

/** Take the next slice of the universe, wrapping around the end. */
export function slice(universe: SymbolRef[], cursor: number, size: number): SymbolRef[] {
  if (universe.length === 0) return [];
  const n = Math.min(size, universe.length);
  const start = cursor % universe.length;
  const end = start + n;
  return end <= universe.length ? universe.slice(start, end) : [...universe.slice(start), ...universe.slice(0, end - universe.length)];
}

/**
 * One study round. Scores a slice of the universe, then researches the best of that slice whose
 * stored research has gone stale. Stops as soon as `deadline` passes, and picks up where it left
 * off next time.
 */
export async function studyRound(deadline: number): Promise<StudyResult> {
  const settings = await getSettings();
  const t = settings.quant;
  if (!t.continuousResearch) return { ran: false, skipped: "continuous study is off" };

  const enabled = (["US", "UK"] as Market[]).filter(
    (market) =>
      settings.markets[market] ||
      (settings.intraday.enabled && (market === "US" ? settings.intraday.usEnabled : settings.intraday.ukEnabled)),
  );
  if (enabled.length === 0) return { ran: false, skipped: "no markets enabled" };

  const client = await tryClient();
  if (!client) return { ran: false, skipped: "no Trading 212 credentials" };

  const market = await pickMarket(enabled);
  const universe = universeOf(await getInstrumentsCached(client), market);
  if (universe.length === 0) return { ran: false, skipped: `no tradable ${market} instruments` };

  const removed = await purgeOutsideUniverse(market, new Set(universe.map((u) => u.ticker)));
  if (removed > 0) await log("info", "study", `Removed ${removed} stored ${market} symbol(s) that are not single stocks.`);

  const cursor = await cursorFor(market);
  // Quotes are cheap (100 symbols per call) but history is not, so scan as many names as it takes to
  // find a useful number of liquid ones. A market where few pass the filter (UK) gets a bigger slice.
  const yieldRate = (await getKv<number>(`study:yield:${market}`))?.value ?? 0.3;
  const size = clampInt(Math.ceil(TARGET_LIQUID_PER_ROUND / Math.max(yieldRate, 0.02)), t.studyBatchSize, MAX_SCAN_PER_ROUND);
  const slab = slice(universe, cursor, size);
  const nextCursor = (cursor + slab.length) % universe.length;
  await setKv(`study:cursor:${market}`, nextCursor);

  // Names an earlier lap found unusable are not worth another quote lookup until their retest date.
  const known = await activeSkips(slab.map((s) => s.yahoo));
  const batch = slab.filter((s) => !known.has(s.yahoo));
  if (batch.length === 0) {
    return { ran: true, market, scanned: slab.length, scored: 0, researched: 0, skippedKnown: known.size };
  }

  const dropped = new Map<string, string>();
  const scored = await scoreSymbols(batch, {
    onDrop: (item, reason) => dropped.set(item.yahoo, reason),
    market,
    nextOpenWeekday: nextOpenWeekday(),
    tuning: t,
    minDollarVolume: market === "US" ? t.usMinDollarVolume : t.ukMinDollarVolume,
    minMarketCap: t.minMarketCap,
    poolCap: MAX_SCORED_PER_ROUND,
  });
  await recordObservations(scored);
  await recordSkips(market, dropped, t.skipRetestDays);

  if (batch.length >= 20 && scored.length === 0 && yieldRate > 0.1) {
    await log("warn", "study", `No ${market} name out of ${batch.length} could be scored. Yahoo may be rate-limiting or down.`);
  } else {
    await setKv(`study:yield:${market}`, 0.7 * yieldRate + 0.3 * (scored.length / batch.length));
  }

  const researched = await researchStalest(scored, t, deadline);

  const pct = Math.round((nextCursor / universe.length) * 100);
  await log(
    "info",
    "study",
    `Studied ${batch.length} ${market} names (${scored.length} liquid enough to score, ${researched} researched${known.size ? `, ${known.size} skipped as known-unusable` : ""}). Rotation ${pct}% through ${universe.length} symbols.`,
  );

  if (Math.random() < 0.05) {
    const pruned = await pruneKnowledge(t.knowledgeRetentionDays);
    if (pruned > 0) await log("info", "study", `Dropped ${pruned} symbol(s) not seen for ${t.knowledgeRetentionDays} days.`);
    await getDb().delete(schema.studySkips).where(lt(schema.studySkips.until, new Date()));
  }

  return { ran: true, market, scanned: slab.length, scored: scored.length, researched, skippedKnown: known.size };
}

/** Full research for the best names in this round whose stored research is missing or stale. */
async function researchStalest(scored: Candidate[], t: QuantTuning, deadline: number): Promise<number> {
  const count = t.studyResearchCount;
  if (count <= 0 || scored.length === 0 || Date.now() >= deadline) return 0;
  const known = await getKnowledge(scored.map((c) => c.yahoo));
  const cutoff = Date.now() - t.knowledgeTtlHours * 3_600_000;

  const stale = scored
    .filter((c) => {
      const row = known.get(c.yahoo);
      return !row?.researchedAt || row.researchedAt.getTime() < cutoff;
    })
    .slice(0, count);
  if (stale.length === 0) return 0;

  // Vetoes depend on earnings, so the stored research has to know about them too.
  await attachEarnings(stale);

  let done = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, stale.length) }, async () => {
      while (next < stale.length && Date.now() < deadline) {
        const c = stale[next++];
        try {
          const { research, analogueSnapshot } = await researchCandidate(c, t);
          await recordResearch(c.yahoo, { ...research, analogue: analogueSnapshot });
          done++;
        } catch {
          /* a symbol Yahoo will not serve should not end the round */
        }
      }
    }),
  );
  return done;
}
