import { eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { log } from "../lib/log";
import { roundTripCostPct } from "../lib/quant/costs";
import { reviewTrade, runLearningCycle } from "../lib/quant/learn";
import { scoreOutcomes } from "./outcomes";

const { trades, decisions, runs, candidates } = schema;

/**
 * After a trade closes: score the whole shortlist's overnight outcomes, write a review derived from
 * predicted-versus-realised, then retrain the model and re-mine the lesson rules. Non-fatal.
 */
export async function finalizeTrade(tradeId: number): Promise<void> {
  const db = getDb();
  const t = await db.select().from(trades).where(eq(trades.id, tradeId)).get();
  if (!t) return;
  try {
    await scoreOutcomes(t.runId);
    const d = (await db.select().from(decisions).where(eq(decisions.id, t.decisionId)).get())!;
    const run = (await db.select().from(runs).where(eq(runs.id, t.runId)).get())!;
    const outcomes = await db.select().from(candidates).where(eq(candidates.runId, t.runId)).all();
    const signals = (outcomes.find((o) => o.ticker === t.ticker)?.signals ?? null) as Record<string, number> | null;

    const review = reviewTrade({
      ticker: t.ticker,
      market: run.market,
      confidence: d.confidence ?? 0,
      expectedMovePct: d.expectedMovePct ?? 0,
      pnlPct: t.pnlPct,
      costPct: roundTripCostPct(
        run.market,
        signals ? { atrPct: Number(signals.atrPct ?? 2), dollarVolume: Number(signals.dollarVolume ?? 5e7) } : undefined,
      ),
      shortlistOutcomes: outcomes.map((o) => ({ ticker: o.ticker, overnightReturnPct: o.overnightReturnPct, picked: o.picked })),
    });

    await db.update(trades).set({ review: `${review.verdict}: ${review.summary}` }).where(eq(trades.id, tradeId)).run();

    const { trained, activeRules } = await runLearningCycle();
    await log(
      "info",
      "review",
      `Trade ${t.ticker} reviewed: ${review.verdict}. Model trained on ${trained} new outcome(s); ${activeRules} rule(s) active.`,
      t.runId,
    );
  } catch (err) {
    await log("warn", "review", `Review failed for trade ${tradeId}: ${String(err).slice(0, 200)}`, t.runId);
  }
}
