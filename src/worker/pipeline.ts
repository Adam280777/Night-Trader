import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { getAccountState, tryClient } from "../lib/account";
import { getInstrumentsCached } from "../lib/t212/instruments";
import { screenUniverse, type Candidate } from "../lib/ai/screener";
import { researchCandidate, researchMarket } from "../lib/ai/research";
import { decide } from "../lib/ai/decide";
import { formatMemoryForPrompt, getActiveLessons, getPerformanceStats } from "../lib/ai/memory";
import type { MarketContext, Research } from "../lib/ai/schemas";
import { checkDecisionGuardrails } from "./guard";

const { runs, candidates, decisions } = schema;
type Cites = { title: string; url: string }[];
type StoredCtx = { ok: boolean; data?: MarketContext; citations?: Cites };

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
 * Stage 2 (status researching): research whichever candidates still lack research, stopping to start new
 * ones once `deadline` passes. Resumable: progress lives in the DB. Moves to "deciding" when nothing is left.
 */
export async function stageResearch(runId: number, deadline: number, concurrency = 3): Promise<void> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return;
  try {
    const ctxKey = `mctx:${runId}`;
    if (!(await getKv(ctxKey))) {
      try {
        const m = await researchMarket(run.market);
        await setKv(ctxKey, { ok: true, data: m.data, citations: m.citations } satisfies StoredCtx);
      } catch (err) {
        await log("warn", "pipeline", `Market context failed: ${String(err).slice(0, 200)}`, runId);
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
            const { research, citations } = await researchCandidate(asCandidate(row, run.market), run.market);
            await db
              .update(candidates)
              .set({ researchSummary: research.summary, research: { ...research, citations } })
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

/** Stage 3 (status deciding): decide -> guardrails -> (approval | ready). Never places orders. */
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
    const results = new Map<string, { research: Research; citations: Cites }>();
    for (const r of rows) {
      if (!r.research) continue;
      const { citations, ...research } = r.research as Research & { citations?: Cites };
      results.set(r.ticker, { research: research as Research, citations: citations ?? [] });
    }
    const shortlist = rows.filter((r) => results.has(r.ticker));
    const researched = shortlist.map((r) => ({ c: asCandidate(r, run.market), research: results.get(r.ticker)!.research }));
    if (researched.length === 0) throw new Error("No researched candidates to decide between");

    const ctxRow = await getKv<StoredCtx>(`mctx:${runId}`);
    const marketCtx = ctxRow?.value.ok ? ctxRow.value : null;
    const acct = await getAccountState(client);
    const memory = formatMemoryForPrompt(await getPerformanceStats(), await getActiveLessons());
    const { decision, note } = await decide({
      market: run.market,
      candidates: researched,
      marketContext: marketCtx?.data ?? null,
      account: { totalValue: acct.totalValue, availableCash: acct.availableCash, currency: acct.currency },
      memory,
      minutesToClose: minutesToClose(),
    });

    const chosen = decision.ticker ? results.get(decision.ticker) : undefined;
    const chosenRow = rows.find((r) => r.ticker === decision.ticker);
    const sources = [...(chosen?.research.sources ?? []), ...(chosen?.citations ?? []), ...(marketCtx?.data?.sources ?? [])];
    const dedup = [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 20);

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
        marketContext: marketCtx?.data ?? null,
        guardrailNotes: note ? [note] : [],
      })
      .returning({ id: decisions.id });

    for (const o of decision.whyNotOthers) {
      const c = rows.find((r) => r.ticker === o.ticker);
      if (c) await db.update(candidates).set({ researchSummary: `Not chosen: ${o.reason}` }).where(eq(candidates.id, c.id));
    }

    if (decision.action === "NO_TRADE") {
      await log("info", "pipeline", `AI decided NO_TRADE. ${decision.thesis}`, runId);
      await setRunStatus(runId, "no_trade");
      return;
    }
    if (chosenRow) await db.update(candidates).set({ picked: true }).where(eq(candidates.id, chosenRow.id));

    const { result } = await checkDecisionGuardrails(row.id, minutesToClose(), acct);
    await db
      .update(decisions)
      .set({ guardrailNotes: [...(note ? [note] : []), ...result.notes, ...result.reasons.map((r) => `BLOCKED: ${r}`)] })
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

