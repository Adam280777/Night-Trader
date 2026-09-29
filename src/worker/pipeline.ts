import { eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getAccountState, tryClient } from "../lib/account";
import { getInstrumentsCached } from "../lib/t212/instruments";
import { screenUniverse } from "../lib/ai/screener";
import { researchAll, researchMarket } from "../lib/ai/research";
import { decide } from "../lib/ai/decide";
import { formatMemoryForPrompt, getActiveLessons, getPerformanceStats } from "../lib/ai/memory";
import type { MarketContext } from "../lib/ai/schemas";
import { checkDecisionGuardrails } from "./guard";

const { runs, candidates, decisions } = schema;

export function setRunStatus(runId: number, status: (typeof runs.$inferSelect)["status"], error?: string) {
  getDb()
    .update(runs)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(runs.id, runId))
    .run();
}

/** Screen -> research -> decide -> guardrails -> (approval | ready). Never places orders. */
export async function researchAndDecide(runId: number): Promise<void> {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return;
  const settings = getSettings();
  const closeAt = run.sessionCloseAt ?? new Date(Date.now() + 3_600_000);
  const minutesToClose = () => (closeAt.getTime() - Date.now()) / 60_000;

  try {
    const client = tryClient();
    if (!client) throw new Error("Trading 212 API credentials are required (instrument universe). Add them in Settings.");

    // 1. Screen
    setRunStatus(runId, "screening");
    const instruments = await getInstrumentsCached(client);
    const shortlist = await screenUniverse(instruments, {
      market: run.market,
      minDollarVolume: run.market === "US" ? 20_000_000 : 5_000_000,
      shortlist: 8,
    });
    if (shortlist.length === 0) throw new Error("Screener found no liquid candidates");
    log("info", "pipeline", `Shortlist (${run.market}): ${shortlist.map((c) => c.ticker).join(", ")}`, runId);

    const candRow = new Map<string, number>();
    for (const c of shortlist) {
      const r = db
        .insert(candidates)
        .values({
          runId,
          ticker: c.ticker,
          name: c.name,
          screenScore: c.score,
          signals: { ...c.signals, yahoo: c.yahoo } as never,
          refPrice: c.price,
        })
        .returning({ id: candidates.id })
        .get();
      candRow.set(c.ticker, r.id);
    }

    // 2. Research (web search)
    setRunStatus(runId, "researching");
    let marketCtx: { data: MarketContext; citations: { title: string; url: string }[] } | null = null;
    try {
      marketCtx = await researchMarket(run.market);
    } catch (err) {
      log("warn", "pipeline", `Market context failed: ${String(err).slice(0, 200)}`, runId);
    }
    const { results, errors } = await researchAll(shortlist, run.market);
    for (const e of errors) log("warn", "pipeline", `Research failed ${e}`, runId);
    for (const [ticker, r] of results) {
      db.update(candidates)
        .set({ researchSummary: r.research.summary, research: { ...r.research, citations: r.citations } })
        .where(eq(candidates.id, candRow.get(ticker)!))
        .run();
    }
    const researched = shortlist.filter((c) => results.has(c.ticker)).map((c) => ({ c, research: results.get(c.ticker)!.research }));
    if (researched.length === 0) throw new Error("Research failed for every candidate");

    // 3. Decide
    setRunStatus(runId, "deciding");
    const acct = await getAccountState(client);
    const memory = formatMemoryForPrompt(getPerformanceStats(), getActiveLessons());
    const { decision, note } = await decide({
      market: run.market,
      candidates: researched,
      marketContext: marketCtx?.data ?? null,
      account: { totalValue: acct.totalValue, availableCash: acct.availableCash, currency: acct.currency },
      memory,
      minutesToClose: minutesToClose(),
    });

    const chosen = decision.ticker ? results.get(decision.ticker) : undefined;
    const chosenCand = shortlist.find((c) => c.ticker === decision.ticker);
    const sources = [...(chosen?.research.sources ?? []), ...(chosen?.citations ?? []), ...(marketCtx?.data.sources ?? [])];
    const dedup = [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 20);

    const row = db
      .insert(decisions)
      .values({
        runId,
        ticker: decision.ticker,
        name: chosenCand?.name ?? null,
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
      .returning({ id: decisions.id })
      .get();

    for (const o of decision.whyNotOthers) {
      const id = candRow.get(o.ticker);
      if (id) db.update(candidates).set({ researchSummary: `Not chosen: ${o.reason}` }).where(eq(candidates.id, id)).run();
    }

    if (decision.action === "NO_TRADE") {
      log("info", "pipeline", `AI decided NO_TRADE. ${decision.thesis}`, runId);
      setRunStatus(runId, "no_trade");
      return;
    }
    db.update(candidates).set({ picked: true }).where(eq(candidates.id, candRow.get(decision.ticker!)!)).run();

    // 4. Guardrails
    const { result } = await checkDecisionGuardrails(row.id, minutesToClose(), acct);
    db.update(decisions)
      .set({ guardrailNotes: [...(note ? [note] : []), ...result.notes, ...result.reasons.map((r) => `BLOCKED: ${r}`)] })
      .where(eq(decisions.id, row.id))
      .run();
    if (!result.allowed) {
      log("warn", "pipeline", `Guardrails blocked ${decision.ticker}: ${result.reasons.join(" ")}`, runId);
      setRunStatus(runId, "blocked", result.reasons.join(" "));
      return;
    }

    // 5. Approval
    if (settings.approvalMode) {
      const deadline = new Date(
        Math.min(Date.now() + settings.approvalWindowMinutes * 60_000, closeAt.getTime() - (settings.minutesBeforeCloseToBuy + 1) * 60_000),
      );
      if (deadline.getTime() <= Date.now() + 30_000) {
        db.update(decisions).set({ approval: "expired" }).where(eq(decisions.id, row.id)).run();
        setRunStatus(runId, "no_trade", "Too late to request approval before the buy window.");
        return;
      }
      db.update(decisions).set({ approval: "pending", approvalDeadline: deadline }).where(eq(decisions.id, row.id)).run();
      setRunStatus(runId, "awaiting_approval");
      log("info", "pipeline", `Waiting for your approval of ${decision.ticker} until ${deadline.toISOString()}`, runId);
    } else {
      setRunStatus(runId, "ready_to_buy");
    }
  } catch (err) {
    log("error", "pipeline", `Run failed: ${String(err)}`, runId);
    setRunStatus(runId, "failed", String(err).slice(0, 500));
  }
}
