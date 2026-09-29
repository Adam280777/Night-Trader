import { eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { log } from "../lib/log";
import { getActiveLessons } from "../lib/ai/memory";
import { reviewTrade } from "../lib/ai/review";
import { scoreOutcomes } from "./outcomes";

const { trades, decisions, runs, candidates, lessons } = schema;

/** After a trade closes: score the shortlist's overnight outcomes, then have the AI write lessons. Non-fatal. */
export async function finalizeTrade(tradeId: number): Promise<void> {
  const db = getDb();
  const t = await db.select().from(trades).where(eq(trades.id, tradeId)).get();
  if (!t) return;
  try {
    await scoreOutcomes(t.runId);
    const d = (await db.select().from(decisions).where(eq(decisions.id, t.decisionId)).get())!;
    const run = (await db.select().from(runs).where(eq(runs.id, t.runId)).get())!;
    const outcomes = await db.select().from(candidates).where(eq(candidates.runId, t.runId)).all();

    const review = await reviewTrade({
      ticker: t.ticker,
      market: run.market,
      thesis: d.thesis ?? "",
      risks: d.risks ?? "",
      confidence: d.confidence ?? 0,
      expectedMovePct: d.expectedMovePct ?? 0,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnlPct: t.pnlPct,
      shortlistOutcomes: outcomes.map((o) => ({ ticker: o.ticker, overnightReturnPct: o.overnightReturnPct, picked: o.picked })),
      existingLessons: (await getActiveLessons(40)).map((l) => l.text),
    });

    await db.update(trades).set({ review: `${review.verdict}: ${review.summary}` }).where(eq(trades.id, tradeId)).run();
    for (const l of review.lessons) db.insert(lessons).values({ tradeId, text: l.text, tags: l.tags }).run();
    await log("info", "review", `Trade ${t.ticker} reviewed: ${review.verdict}; ${review.lessons.length} new lesson(s).`, t.runId);
  } catch (err) {
    await log("warn", "review", `Review failed for trade ${tradeId}: ${String(err).slice(0, 200)}`, t.runId);
  }
}
