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

import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { tryClient } from "../lib/account";
import { getInstrumentsCached, type Market } from "../lib/t212/instruments";
import { attachEarnings, scoreSymbols, universeOf, type Candidate, type SymbolRef } from "../lib/quant/screener";
import { researchCandidate } from "../lib/quant/research";
import { getKnowledge, pruneKnowledge, recordObservations, recordResearch } from "../lib/quant/knowledge";
import type { QuantTuning } from "../lib/quant/tuning";
import { nextOpenWeekday } from "./pipeline";

export interface StudyResult {
  ran: boolean;
  skipped?: string;
  market?: Market;
  scanned?: number;
  scored?: number;
  researched?: number;
}

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

  const enabled = (["US", "UK"] as Market[]).filter((m) => settings.markets[m]);
  if (enabled.length === 0) return { ran: false, skipped: "no markets enabled" };

  const client = await tryClient();
  if (!client) return { ran: false, skipped: "no Trading 212 credentials" };

  const market = await pickMarket(enabled);
  const universe = universeOf(await getInstrumentsCached(client), market);
  if (universe.length === 0) return { ran: false, skipped: `no tradable ${market} instruments` };

  const cursor = await cursorFor(market);
  const batch = slice(universe, cursor, t.studyBatchSize);
  await setKv(`study:cursor:${market}`, (cursor + batch.length) % universe.length);

  const scored = await scoreSymbols(batch, {
    market,
    nextOpenWeekday: nextOpenWeekday(),
    tuning: t,
    minDollarVolume: market === "US" ? t.usMinDollarVolume : t.ukMinDollarVolume,
    minMarketCap: t.minMarketCap,
  });
  await recordObservations(scored);

  const researched = await researchStalest(scored, t, deadline);

  const pct = Math.round(((cursor + batch.length) / universe.length) * 100);
  await log(
    "info",
    "study",
    `Studied ${batch.length} ${market} names (${scored.length} liquid enough to score, ${researched} researched). Rotation ${pct}% through ${universe.length} symbols.`,
  );

  if (Math.random() < 0.05) {
    const dropped = await pruneKnowledge(t.knowledgeRetentionDays);
    if (dropped > 0) await log("info", "study", `Dropped ${dropped} symbol(s) not seen for ${t.knowledgeRetentionDays} days.`);
  }

  return { ran: true, market, scanned: batch.length, scored: scored.length, researched };
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
