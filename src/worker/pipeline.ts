import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { getAccountState, tryClient } from "../lib/account";
import { getInstrumentsCached } from "../lib/t212/instruments";
import { screenUniverse, scoreSymbols, attachEarnings, type Candidate } from "../lib/quant/screener";
import { researchCandidate } from "../lib/quant/research";
import { freshResearchOf, getKnowledge, provenSymbols, recordResearch } from "../lib/quant/knowledge";
import type { QuantTuning } from "../lib/quant/tuning";
import { getRegime } from "../lib/quant/regime";
import { decide } from "../lib/quant/decide";
import { loadModel } from "../lib/quant/model";
import { loadRules } from "../lib/quant/rules";
import { deserializeAnalogue, type AnalogueSnapshot } from "../lib/quant/analogues";
import type { MarketContext, Research, Source } from "../lib/quant/schemas";
import { checkDecisionGuardrails } from "./guard";

const { runs, candidates, decisions } = schema;
type StoredCtx = { ok: boolean; data?: MarketContext };

export async function setRunStatus(runId: number, status: (typeof runs.$inferSelect)["status"], error?: string) {
  await getDb()
    .update(runs)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(runs.id, runId));
}

async function getRun(runId: number) {
  const [run] = await getDb().select().from(runs).where(eq(runs.id, runId));
  return run;
}

async function fail(runId: number, err: unknown) {
  await log("error", "pipeline", `Run failed: ${String(err)}`, runId);
  await setRunStatus(runId, "failed", String(err).slice(0, 500));
}

/** Weekday (UTC) of the open we are trading into: tomorrow, rolled forward over the weekend. */
export function nextOpenWeekday(from = new Date()): number {
  const wd = new Date(from.getTime() + 86_400_000).getUTCDay();
  return wd === 6 || wd === 0 ? 1 : wd;
}

/** Stage 1 (status scheduled): screen the universe and store the shortlist. Moves the run to "researching". */
export async function stageScreen(runId: number): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return;
  try {
    const client = await tryClient();
    if (!client) throw new Error("Trading 212 API credentials are required (instrument universe). Add them in Settings.");
    await setRunStatus(runId, "screening");
    const instruments = await getInstrumentsCached(client);
    const tuning = (await getSettings()).quant;
    const shortlist = await screenUniverse(instruments, {
      market: run.market,
      minDollarVolume: run.market === "US" ? tuning.usMinDollarVolume : tuning.ukMinDollarVolume,
      shortlist: tuning.shortlistSize,
      nextOpenWeekday: nextOpenWeekday(),
      tuning,
    });
    const boosted = await boostFromKnowledge(shortlist, run.market, tuning, runId);
    if (boosted.length === 0) throw new Error("Screener found no liquid candidates");
    await log("info", "pipeline", `Shortlist (${run.market}): ${boosted.map((c) => c.ticker).join(", ")}`, runId);
    await db.delete(candidates).where(eq(candidates.runId, runId));
    await db.insert(candidates).values(
      boosted.map((c) => ({
        runId,
        ticker: c.ticker,
        name: c.name,
        screenScore: c.score,
        signals: { ...c.signals, yahoo: c.yahoo } as never,
        refPrice: c.price,
      })),
    );
    await setRunStatus(runId, "researching");
  } catch (err) {
    await fail(runId, err);
  }
}

/**
 * Give the shortlist a few extra slots for names the knowledge base has watched over many rounds
 * and consistently rated well, even if tonight's screen ranked them just outside. Their signals are
 * recomputed from fresh prices here - only the decision to look at them comes from the stored
 * record, never the numbers the model is judged on.
 */
async function boostFromKnowledge(shortlist: Candidate[], market: "US" | "UK", tuning: QuantTuning, runId: number): Promise<Candidate[]> {
  if (tuning.knowledgeBoostCount <= 0) return shortlist;
  try {
    const have = new Set(shortlist.map((c) => c.ticker));
    const proven = await provenSymbols(market, {
      minObservations: tuning.minObservationsToTrust,
      limit: tuning.knowledgeBoostCount,
      exclude: have,
    });
    if (proven.length === 0) return shortlist;

    const extra = await scoreSymbols(
      proven.map((r) => ({ ticker: r.ticker, name: r.name ?? r.ticker, yahoo: r.symbol })),
      { market, nextOpenWeekday: nextOpenWeekday(), tuning },
    );
    if (extra.length === 0) return shortlist;
    await attachEarnings(extra);
    await log("info", "pipeline", `Knowledge base added ${extra.map((c) => c.ticker).join(", ")} to the shortlist.`, runId);
    return [...shortlist, ...extra];
  } catch (err) {
    // The base is an enhancement; a failure here must not cost us the night's trade.
    await log("warn", "pipeline", `Knowledge boost skipped: ${String(err).slice(0, 200)}`, runId);
    return shortlist;
  }
}

/**
 * Stage 2 (status researching): read the market regime once, then gather headlines and historical
 * analogues for whichever candidates still lack them, stopping once `deadline` passes. Resumable:
 * progress lives in the DB. Moves to "deciding" when nothing is left.
 */
export async function stageResearch(runId: number, deadline: number, concurrency = 4): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return;
  try {
    const researchTuning = (await getSettings()).quant;
    const ctxKey = `mctx:${runId}`;
    if (!(await getKv(ctxKey))) {
      try {
        const regime = await getRegime(run.market);
        await setKv(ctxKey, { ok: true, data: regime.context } satisfies StoredCtx);
        await log("info", "pipeline", `Regime (${run.market}): ${regime.context.summary}`, runId);
      } catch (err) {
        await log("warn", "pipeline", `Market regime unavailable: ${String(err).slice(0, 200)}`, runId);
        await setKv(ctxKey, { ok: false } satisfies StoredCtx);
      }
    }

    const pending = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.runId, runId), isNull(candidates.researchSummary)))
      .orderBy(asc(candidates.id));

    // Anything the all-day study already researched recently is reused as-is. That is the point of
    // the knowledge base: the pre-close window is short, and every symbol served from here is one
    // more that gets looked at properly before the close instead of being left unresearched.
    const known = await getKnowledge(pending.map((r) => yahooOf(r)).filter(Boolean));
    let reused = 0;
    const toFetch: typeof pending = [];
    for (const row of pending) {
      const cached = freshResearchOf(known.get(yahooOf(row)), researchTuning.knowledgeTtlHours);
      if (!cached) {
        toFetch.push(row);
        continue;
      }
      await db
        .update(candidates)
        .set({ researchSummary: cached.summary, research: { ...cached, ticker: row.ticker } })
        .where(eq(candidates.id, row.id));
      reused++;
    }
    if (reused > 0) await log("info", "pipeline", `Reused already-studied research for ${reused} candidate(s).`, runId);

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, toFetch.length) }, async () => {
        while (next < toFetch.length && Date.now() < deadline) {
          const row = toFetch[next++];
          try {
            const { research, analogueSnapshot } = await researchCandidate(asCandidate(row, run.market), researchTuning);
            await db
              .update(candidates)
              .set({ researchSummary: research.summary, research: { ...research, analogue: analogueSnapshot } })
              .where(eq(candidates.id, row.id));
            // Fold it back into the base so the next run does not have to fetch it again.
            await recordResearch(yahooOf(row), { ...research, analogue: analogueSnapshot }).catch(() => {});
          } catch (err) {
            const msg = String(err).slice(0, 200);
            await log("warn", "pipeline", `Research failed ${row.ticker}: ${msg}`, runId);
            await db.update(candidates).set({ researchSummary: `Research failed: ${msg}` }).where(eq(candidates.id, row.id));
          }
        }
      }),
    );

    const left = await db.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.runId, runId), isNull(candidates.researchSummary)));
    if (left.length > 0) return; // continue on the next tick
    const rows = await db.select().from(candidates).where(eq(candidates.runId, runId));
    if (!rows.some((r) => r.research)) throw new Error("Research failed for every candidate");
    await setRunStatus(runId, "deciding");
  } catch (err) {
    await fail(runId, err);
  }
}

function yahooOf(row: typeof candidates.$inferSelect): string {
  return String(((row.signals ?? {}) as Record<string, unknown>).yahoo ?? "");
}

function asCandidate(row: typeof candidates.$inferSelect, market: "US" | "UK"): Candidate {
  const sig = (row.signals ?? {}) as Record<string, unknown>;
  return {
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    yahoo: String(sig.yahoo ?? ""),
    market,
    type: "STOCK",
    currency: "",
    price: row.refPrice ?? 0,
    signals: sig as unknown as Candidate["signals"],
    score: row.screenScore ?? 0,
  };
}

/** Stage 3 (status deciding): evaluate -> guardrails -> (approval | ready). Never places orders. */
export async function stageDecide(runId: number): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return;
  const settings = await getSettings();
  const closeAt = run.sessionCloseAt ?? new Date(Date.now() + 3_600_000);
  const minutesToClose = () => (closeAt.getTime() - Date.now()) / 60_000;

  try {
    const client = await tryClient();
    if (!client) throw new Error("Trading 212 API credentials are required. Add them in Settings.");
    // A decision row only exists here if an earlier attempt died before moving the run on; start clean.
    await db.delete(decisions).where(eq(decisions.runId, runId));

    const rows = await db.select().from(candidates).where(eq(candidates.runId, runId)).orderBy(asc(candidates.id));
    const ctxRow = await getKv<StoredCtx>(`mctx:${runId}`);
    const marketCtx = ctxRow?.value.ok ? (ctxRow.value.data ?? null) : null;

    const inputs = rows
      .filter((r) => r.research)
      .map((r) => {
        const { analogue, ...research } = r.research as Research & { analogue?: AnalogueSnapshot };
        return {
          row: r,
          candidate: asCandidate(r, run.market),
          research: research as Research,
          analogue: deserializeAnalogue(analogue ?? null),
        };
      });
    if (inputs.length === 0) throw new Error("No researched candidates to decide between");

    const acct = await getAccountState(client);
    const minConfidence = run.market === "UK" ? Math.max(settings.minConfidence, settings.ukMinConfidence) : settings.minConfidence;

    const { decision, evaluated, chosen } = decide({
      market: run.market,
      candidates: inputs.map(({ candidate, research, analogue }) => ({ candidate, research, analogue })),
      context: marketCtx,
      model: await loadModel(),
      rules: await loadRules(),
      account: { totalValue: acct.totalValue, availableCash: acct.availableCash, currency: acct.currency },
      minutesToClose: minutesToClose(),
      minConfidence,
      minEdgePct: settings.minExpectedEdgePct,
      tuning: settings.quant,
      forceTrade: run.mode === "demo" && settings.demoForceTrade ? { investPct: settings.demoForceInvestPct } : undefined,
    });

    // Persist every candidate's feature vector and evaluation: this is tomorrow's training data.
    const byTicker = new Map(evaluated.map((e) => [e.evaluation.ticker, e]));
    for (const { row } of inputs) {
      const e = byTicker.get(row.ticker);
      if (!e) continue;
      await db.update(candidates).set({ features: e.features, evaluation: e.evaluation }).where(eq(candidates.id, row.id));
    }

    const chosenRow = inputs.find((i) => i.row.ticker === decision.ticker)?.row;
    const sources: Source[] = [...(chosen?.input.research?.sources ?? []), ...(marketCtx?.sources ?? [])];
    const dedup = [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 20);
    const lessonNotes = decision.lessonsApplied.map((l) => `Lesson applied: ${l}`);

    const [row] = await db
      .insert(decisions)
      .values({
        runId,
        ticker: decision.ticker,
        name: chosenRow?.name ?? null,
        action: decision.action,
        confidence: decision.confidence,
        investPct: decision.investPct,
        thesis: decision.thesis,
        expectedMovePct: decision.expectedMovePct,
        exitPlan: decision.exitPlan,
        risks: decision.risks,
        sources: dedup,
        marketContext: marketCtx ?? null,
        forced: decision.forced === true,
        guardrailNotes: lessonNotes,
      })
      .returning({ id: decisions.id });

    for (const o of decision.whyNotOthers) {
      const c = inputs.find((i) => i.row.ticker === o.ticker);
      if (c) {
        await db
          .update(candidates)
          .set({ researchSummary: `${c.row.researchSummary ?? ""}\n\nNot chosen: ${o.reason}`.trim() })
          .where(eq(candidates.id, c.row.id));
      }
    }

    if (decision.action === "NO_TRADE") {
      await log("info", "pipeline", `No trade. ${decision.thesis.slice(0, 200)}`, runId);
      await setRunStatus(runId, "no_trade");
      return;
    }
    if (chosenRow) await db.update(candidates).set({ picked: true }).where(eq(candidates.id, chosenRow.id));

    // An intraday position may still be winding down while overnight research finishes. Position
    // ownership is transient, so defer that one check until executeBuy re-runs every guardrail.
    const { result } = await checkDecisionGuardrails(row.id, minutesToClose(), acct, { ignoreOpenPosition: true });
    await db
      .update(decisions)
      .set({ guardrailNotes: [...lessonNotes, ...result.notes, ...result.reasons.map((r) => `BLOCKED: ${r}`)] })
      .where(eq(decisions.id, row.id));
    if (!result.allowed) {
      await log("warn", "pipeline", `Guardrails blocked ${decision.ticker}: ${result.reasons.join(" ")}`, runId);
      await setRunStatus(runId, "blocked", result.reasons.join(" "));
      return;
    }

    if (decision.forced) {
      // Demo money and a learning goal: no point waiting on a human to approve a trade made to be studied.
      await log("info", "pipeline", `Demo exploration: the engine would have passed, so it is buying ${decision.ticker} anyway to learn from the result.`, runId);
      await setRunStatus(runId, "ready_to_buy");
    } else if (settings.approvalMode) {
      const deadline = new Date(
        Math.min(Date.now() + settings.approvalWindowMinutes * 60_000, closeAt.getTime() - (settings.minutesBeforeCloseToBuy + 1) * 60_000),
      );
      if (deadline.getTime() <= Date.now() + 30_000) {
        await db.update(decisions).set({ approval: "expired" }).where(eq(decisions.id, row.id));
        await setRunStatus(runId, "no_trade", "Too late to request approval before the buy window.");
        return;
      }
      await db.update(decisions).set({ approval: "pending", approvalDeadline: deadline }).where(eq(decisions.id, row.id));
      await setRunStatus(runId, "awaiting_approval");
      await log("info", "pipeline", `Waiting for your approval of ${decision.ticker} until ${deadline.toISOString()}`, runId);
    } else {
      await setRunStatus(runId, "ready_to_buy");
    }
  } catch (err) {
    await fail(runId, err);
  }
}
