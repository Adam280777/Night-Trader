import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { log } from "../lib/log";
import { getDailyBars } from "../lib/market/data";
import { tradingDateOf } from "../lib/market/sessions";

const { candidates, runs } = schema;

/**
 * Counterfactual learning: for every shortlisted stock (picked or not), record the actual
 * close -> next-open return once the next open exists. This gives ~8 data points per day
 * instead of 1, and shows whether the model beats the screener.
 */
export async function scoreOutcomes(onlyRunId?: number): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ c: candidates, run: runs })
    .from(candidates)
    .innerJoin(runs, eq(candidates.runId, runs.id))
    .where(
      onlyRunId
        ? and(isNull(candidates.overnightReturnPct), eq(runs.id, onlyRunId), eq(runs.strategy, "overnight"))
        : and(isNull(candidates.overnightReturnPct), eq(runs.strategy, "overnight")),
    )
    .all();

  const barsCache = new Map<string, Awaited<ReturnType<typeof getDailyBars>>>();
  let scored = 0;
  for (const { c, run } of rows) {
    const yahoo = (c.signals as Record<string, string> | null)?.yahoo;
    if (!yahoo) continue;
    try {
      if (!barsCache.has(yahoo)) barsCache.set(yahoo, await getDailyBars(yahoo, 20));
      const bars = barsCache.get(yahoo)!;
      const withDate = bars.map((b) => ({ b, d: tradingDateOf(run.market, b.date) }));
      const ref = withDate.find((x) => x.d === run.tradingDate);
      const next = withDate.find((x) => x.d > run.tradingDate);
      if (!ref || !next) continue;
      await db.update(candidates)
        .set({
          refPrice: ref.b.close,
          nextOpenPrice: next.b.open,
          overnightReturnPct: (next.b.open / ref.b.close - 1) * 100,
        })
        .where(eq(candidates.id, c.id))
        .run();
      scored++;
    } catch (err) {
      await log("warn", "outcomes", `Could not score ${c.ticker}: ${String(err).slice(0, 150)}`, run.id);
    }
  }
  return scored;
}
