/**
 * Historical backfill: replays past sessions of symbols the study loop has already found tradable
 * into the model, so it learns from thousands of labelled nights instead of waiting for eight a day.
 * Runs only in spare tick time, after live work and study.
 */

import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { getKv, setKv } from "../lib/kv";
import { log } from "../lib/log";
import { getDailyBars } from "../lib/market/data";
import type { Market } from "../lib/t212/instruments";
import { predict, train, type TrainingSample } from "../lib/quant/model";
import { governanceThresholds, persistTrainedVersion, trainingBase, type ModelScope } from "../lib/quant/governance";
import {
  BACKFILL_STATS_KEY,
  marketContextSeries,
  replayFrozenFeatures,
  replaySymbol,
  selectShortlisted,
  toTrainingSamples,
  type BackfillStats,
  type ReplayRow,
} from "../lib/quant/backfill";

const { knowledge } = schema;

/** Bars to request: roughly two years, enough for ~450 replayable nights per name after warm-up. */
const BACKFILL_DAYS = 500;
/**
 * AdaGrad shrinks the step size as gradients accumulate. A large replay would leave nothing for the
 * handful of live outcomes that arrive each day, so the accumulators are capped afterwards at roughly
 * the weight of a couple of hundred live samples.
 */
const GRAD2_CAP = 50;

export interface BackfillResult {
  ran: boolean;
  skipped?: string;
  symbols?: number;
  nights?: number;
}

async function pickMarket(enabled: Market[]): Promise<Market[]> {
  const last = (await getKv<Market>("backfill:market"))?.value;
  const i = last ? enabled.indexOf(last) : -1;
  const first = (i + 1) % enabled.length;
  const order = [...enabled.slice(first), ...enabled.slice(0, first)];
  if (order[0]) await setKv("backfill:market", order[0]);
  return order;
}

export async function backfillRound(deadline: number): Promise<BackfillResult> {
  const settings = await getSettings();
  const t = settings.quant;
  if (!t.backfillEnabled || t.backfillMaxSymbols <= 0) return { ran: false, skipped: "backfill is off" };

  const enabled = (["US", "UK"] as Market[]).filter((m) => settings.markets[m]);
  if (enabled.length === 0) return { ran: false, skipped: "no markets enabled" };

  const db = getDb();
  const [{ done }] = await db
    .select({ done: sql<number>`count(*)` })
    .from(knowledge)
    .where(isNotNull(knowledge.backfilledAt));
  const budget = t.backfillMaxSymbols - Number(done ?? 0);
  if (budget <= 0) return { ran: false, skipped: "backfill symbol budget used" };

  let market: Market | null = null;
  let pending: (typeof knowledge.$inferSelect)[] = [];
  for (const m of await pickMarket(enabled)) {
    pending = await db
      .select()
      .from(knowledge)
      .where(and(eq(knowledge.market, m), isNull(knowledge.backfilledAt)))
      .orderBy(desc(knowledge.observations), asc(knowledge.symbol))
      .limit(Math.min(t.backfillSymbolsPerRound, budget));
    if (pending.length > 0) {
      market = m;
      break;
    }
  }
  if (!market) return { ran: false, skipped: "every studied symbol is already backfilled" };

  // Index and VIX history let the replay learn the market-regime features too. Without it (or for
  // markets with no matching series) those features stay frozen rather than being filled with neutral values.
  let marketContext: ReturnType<typeof marketContextSeries> | undefined;
  if (market === "US") {
    try {
      const [spx, vix] = await Promise.all([getDailyBars("^GSPC", BACKFILL_DAYS), getDailyBars("^VIX", BACKFILL_DAYS)]);
      const series = marketContextSeries(spx, vix);
      if (series.size > 100) marketContext = series;
    } catch {
      /* fall back to price-only replay */
    }
  }

  const rows: ReplayRow[] = [];
  const finished: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length && Date.now() < deadline) {
        const k = pending[next++];
        try {
          const bars = await getDailyBars(k.symbol, BACKFILL_DAYS);
          rows.push(
            ...replaySymbol(
              bars,
              { symbol: k.symbol, market: k.market, currency: k.symbol.endsWith(".L") ? "GBp" : "USD" },
              t,
              { marketContext },
            ),
          );
          finished.push(k.symbol);
        } catch {
          /* Yahoo hiccup: leave it unstamped so a later round retries */
        }
      }
    }),
  );
  if (finished.length === 0) return { ran: false, skipped: "no history could be fetched" };

  const chosen = selectShortlisted(rows, t.backfillTopFraction);
  if (chosen.length > 0) {
    const samples: TrainingSample[] = toTrainingSamples(chosen, t.backfillWeight);
    const sharedBase = await trainingBase("shared");

    // Score the batch before learning from it, so the skill figure is honest.
    const rate = chosen.filter((r) => r.label).length / chosen.length;
    let brier = 0;
    let baseline = 0;
    for (const r of chosen) {
      const y = r.label ? 1 : 0;
      brier += (predict(sharedBase.state, r.features).raw - y) ** 2;
      baseline += (rate - y) ** 2;
    }

    const scopes: ModelScope[] = ["shared"];
    if (chosen.length >= governanceThresholds().marketTrainingSamples) scopes.push(market);
    for (const scope of scopes) {
      const base = scope === "shared" ? sharedBase : await trainingBase(scope);
      const trained = train(base.state, samples, t, { frozen: replayFrozenFeatures(!!marketContext), calibrate: false });
      for (const k of Object.keys(trained.grad2)) trained.grad2[k] = Math.min(trained.grad2[k], GRAD2_CAP);
      trained.biasGrad2 = Math.min(trained.biasGrad2, GRAD2_CAP);
      await persistTrainedVersion({
        scope,
        parentVersionId: base.id,
        state: trained,
        tuning: t,
        window: {
          from: chosen.map((row) => row.date).sort()[0],
          to: chosen.map((row) => row.date).sort().at(-1)!,
        },
        metrics: {
          brier: brier / chosen.length,
          baselineBrier: baseline / chosen.length,
        },
        reason: `historical replay of ${chosen.length} shortlisted ${market} overnight candidates`,
      });
    }

    const prev = (await getKv<BackfillStats>(BACKFILL_STATS_KEY))?.value;
    await setKv(BACKFILL_STATS_KEY, {
      symbols: (prev?.symbols ?? 0) + finished.length,
      nights: (prev?.nights ?? 0) + chosen.length,
      brierSum: (prev?.brierSum ?? 0) + brier,
      baselineBrierSum: (prev?.baselineBrierSum ?? 0) + baseline,
      updatedAt: Date.now(),
    } satisfies BackfillStats);

    await log(
      "info",
      "backfill",
      `Replayed ${rows.length} past ${market} nights${marketContext ? " with market history" : ""} from ${finished.length} symbols and trained on the ${chosen.length} the screener would have shortlisted ` +
        `(${Math.round(rate * 100)}% cleared costs). Error before learning ${(brier / chosen.length).toFixed(3)} vs ${(baseline / chosen.length).toFixed(3)} for guessing the base rate.`,
    );
  } else {
    await log("info", "backfill", `Replayed ${finished.length} ${market} symbols but none had enough usable history.`);
  }

  await db.update(knowledge).set({ backfilledAt: new Date() }).where(inArray(knowledge.symbol, finished));
  return { ran: true, symbols: finished.length, nights: chosen.length };
}
