import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { getAccountState, tryClient } from "../lib/account";
import { getInstrumentsCached } from "../lib/t212/instruments";
import { screenUniverse, type Candidate } from "../lib/quant/screener";
import { researchCandidate } from "../lib/quant/research";
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
    const shortlist = await screenUniverse(instruments, {
      market: run.market,
      minDollarVolume: run.market === "US" ? 20_000_000 : 5_000_000,
      shortlist: 8,
      nextOpenWeekday: nextOpenWeekday(),
    });
    if (shortlist.length === 0) throw new Error("Screener found no liquid candidates");
    await log("info", "pipeline", `Shortlist (${run.market}): ${shortlist.map((c) => c.ticker).join(", ")}`, runId);
    await db.delete(candidates).where(eq(candidates.runId, runId));
    await db.insert(candidates).values(
      shortlist.map((c) => ({
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
 * Stage 2 (status researching): read the market regime once, then gather headlines and historical
 * analogues for whichever candidates still lack them, stopping once `deadline` passes. Resumable:
 * progress lives in the DB. Moves to "deciding" when nothing is left.
 */
export async function stageResearch(runId: number, deadline: number, concurrency = 4): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return;
  try {
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
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        while (next < pending.length && Date.now() < deadline) {
          const row = pending[next++];
          try {
            const { research, analogueSnapshot } = await researchCandidate(asCandidate(row, run.market));
            await db
              .update(candidates)
              .set({ researchSummary: research.summary, research: { ...research, analogue: analogueSnapshot } })
              .where(eq(candidates.id, row.id));
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

    const { result } = await checkDecisionGuardrails(row.id, minutesToClose(), acct);
    await db
      .update(decisions)
      .set({ guardrailNotes: [...lessonNotes, ...result.notes, ...result.reasons.map((r) => `BLOCKED: ${r}`)] })
      .where(eq(decisions.id, row.id));
    if (!result.allowed) {
      await log("warn", "pipeline", `Guardrails blocked ${decision.ticker}: ${result.reasons.join(" ")}`, runId);
      await setRunStatus(runId, "blocked", result.reasons.join(" "));
      return;
    }

    if (settings.approvalMode) {
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
