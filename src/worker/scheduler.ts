import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { currentMode, getSettings } from "../lib/config";
import { log } from "../lib/log";
import { getKv, setKv } from "../lib/kv";
import { withLock } from "../lib/locks";
import { pruneOperationalData } from "../lib/retention";
import { traced } from "../lib/trace";
import { getAccountState, tryClient } from "../lib/account";
import { currentOrNextSession, nextSessionAfter, minutes } from "../lib/market/calendar";
import { getMarketSessions, tradingDateOf } from "../lib/market/sessions";
import type { Market } from "../lib/t212/instruments";
import { setRunStatus, stageDecide, stageResearch, stageScreen } from "./pipeline";
import { executeBuy } from "./execute";
import { executeExit } from "./exit";
import { scoreOutcomes } from "./outcomes";
import { runLearningCycle } from "../lib/quant/learn";
import { studyRound } from "./study";
import { backfillRound } from "./backfill";

const { runs, decisions, trades, equitySnapshots, orders, candidates } = schema;

const MARKETS: Market[] = ["US", "UK"];
const TERMINAL_STATUSES = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

/** Injectable clock so the whole day can be simulated in tests. */
export interface SchedulerDeps {
  now: () => Date;
}
const realClock: SchedulerDeps = { now: () => new Date() };

/** One tick may use at most this long (Vercel's function limit is 300s). */
export const TICK_BUDGET_MS = 270_000;
/** Don't start new research work after this point in a tick; one candidate takes a few seconds. */
const RESEARCH_CUTOFF_MS = 210_000;
/** The decision itself is local arithmetic, so it only needs room for the account/guardrail calls. */
const DECIDE_MIN_REMAINING_MS = 25_000;
/** Studying gets whatever is left of the tick, and is cut off well before the function limit. */
const STUDY_CUTOFF_MS = 200_000;

export interface TickResult {
  ran: boolean;
  skipped?: string;
  activeRuns?: number;
  studied?: number;
}

async function warnOnce(key: string, message: string, runId: number | undefined, nowMs: number) {
  const k = await getKv<number>(`warn:${key}`);
  if (k && nowMs - k.value < 30 * 60_000) return;
  await setKv(`warn:${key}`, nowMs);
  await log("warn", "scheduler", message, runId);
}

async function every(name: string, everyMs: number, nowMs: number): Promise<boolean> {
  const last = await getKv<number>(`t:${name}`);
  if (last && nowMs - last.value < everyMs) return false;
  await setKv(`t:${name}`, nowMs);
  return true;
}

/**
 * Only one tick runs at a time (DB lease), so anything still "in progress" when a tick starts was
 * left behind by a tick that died. Repair it before doing anything else.
 */
async function recover(nowMs: number): Promise<void> {
  const db = getDb();

  // An order intent with no T212 id might or might not have reached the broker: never guess, never resend.
  const stale = await db.select().from(orders).where(eq(orders.status, "intent"));
  for (const o of stale) {
    await db.update(orders).set({ status: "unknown", error: "The scheduler stopped before the order call returned", updatedAt: new Date() }).where(eq(orders.id, o.id));
    await log("error", "recovery", `Order #${o.id} (${o.side} ${o.ticker}) has an unknown outcome. Check Trading 212, then resolve it in the app.`, o.runId ?? undefined);
  }

  const interrupted = await db.select().from(runs).where(eq(runs.status, "screening"));
  for (const r of interrupted) {
    const minsLeft = ((r.sessionCloseAt?.getTime() ?? 0) - nowMs) / 60_000;
    if (minsLeft > 15) {
      await db.delete(candidates).where(eq(candidates.runId, r.id));
      await setRunStatus(r.id, "scheduled");
      await log("info", "recovery", `Run #${r.id} screening was interrupted; restarting it (${Math.round(minsLeft)} min to close).`, r.id);
    } else {
      await setRunStatus(r.id, "failed", "Interrupted too close to the close");
    }
  }

  // Died mid-buy: trust the broker's position list.
  const executing = await db.select().from(runs).where(eq(runs.status, "executing"));
  if (executing.length === 0) return;
  const client = await tryClient();
  for (const r of executing) {
    const [d] = await db.select().from(decisions).where(eq(decisions.runId, r.id)).orderBy(desc(decisions.id)).limit(1);
    const [hasTrade] = await db.select().from(trades).where(eq(trades.runId, r.id)).limit(1);
    if (hasTrade) {
      await setRunStatus(r.id, "holding");
      continue;
    }
    if (r.mode !== "dry" && client && d?.ticker) {
      const pos = (await client.getPositions(d.ticker)).find((p) => p.instrument.ticker === d.ticker);
      if (pos && pos.quantity > 0) {
        await db
          .insert(trades)
          .values({ runId: r.id, decisionId: d.id, ticker: d.ticker, name: d.name, quantity: pos.quantity, entryPrice: pos.averagePricePaid, entryAt: new Date(), status: "open" });
        await setRunStatus(r.id, "holding");
        await log("warn", "recovery", `Recovered open position ${pos.quantity} ${d.ticker} for run #${r.id}.`, r.id);
        continue;
      }
    }
    await setRunStatus(r.id, "failed", "Interrupted during buy; no position found");
  }
}

export interface EnsureStatus {
  text: string;
  /** True when a run would normally be created but something is stopping it. */
  notable?: boolean;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z";

/** Create today's run for a market once we are inside its research window. Always says why it did or did not. */
async function ensureRun(market: Market, deps: SchedulerDeps): Promise<EnsureStatus> {
  const settings = await getSettings();
  if (!settings.markets[market]) return { text: `${market} is switched off in Settings` };
  if (settings.killSwitch) return { text: "Kill switch is on" };
  const client = await tryClient();
  if (!client) return { text: "No Trading 212 credentials" };
  const now = deps.now();
  const db = getDb();

  const session = currentOrNextSession(await getMarketSessions(client, market), now);
  if (!session) return { text: "No upcoming session in the Trading 212 schedule", notable: true };
  const start = session.close.getTime() - minutes(settings.minutesBeforeCloseToResearch);
  const end = session.close.getTime() - minutes(settings.minutesBeforeCloseToBuy + 2);
  if (now < session.open) return { text: `Market opens ${hhmm(session.open.getTime())}; run window ${hhmm(start)}-${hhmm(end)}` };
  if (now.getTime() < start) return { text: `Run window opens ${hhmm(start)}` };
  if (now.getTime() >= end) return { text: `Run window closed at ${hhmm(end)}` };

  // One position at a time: never open a second run while a trade is open.
  const [openTrade] = await db.select({ id: trades.id }).from(trades).where(eq(trades.status, "open")).limit(1);
  if (openTrade) return { text: "A position is still open; one trade at a time", notable: true };

  const tradingDate = tradingDateOf(market, session.close);
  const [existing] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.tradingDate, tradingDate), eq(runs.market, market)))
    .limit(1);
  if (existing) return { text: `Run #${existing.id} for ${tradingDate} is ${existing.status}` };

  // Cross-market rule: once one market has produced a trade today, don't start the other.
  const [sameDayTrade] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.tradingDate, tradingDate), inArray(runs.status, ["holding", "exiting", "executing"])))
    .limit(1);
  if (sameDayTrade) return { text: `Run #${sameDayTrade.id} already holds a position for ${tradingDate}`, notable: true };

  const mode = await currentMode(settings);
  const [row] = await db
    .insert(runs)
    .values({ tradingDate, market, mode, status: "scheduled", sessionCloseAt: session.close })
    .returning({ id: runs.id });
  await log("info", "scheduler", `Created ${mode.toUpperCase()} run #${row.id} for ${market} ${tradingDate} (closes ${session.close.toISOString()})`, row.id);
  return { text: `Created run #${row.id}` };
}

/** Remember the latest reason per market so the Activity page can answer "why is there no run?". */
async function recordEnsure(market: Market, status: EnsureStatus, nowMs: number): Promise<void> {
  const prev = await getKv<{ text: string; at: number }>(`ensure:${market}`);
  if (prev && prev.value.text === status.text && nowMs - prev.value.at < 10 * 60_000) return;
  await setKv(`ensure:${market}`, { text: status.text, at: nowMs });
}

async function processRun(run: typeof runs.$inferSelect, deps: SchedulerDeps, startedAt: number): Promise<void> {
  const db = getDb();
  const settings = await getSettings();
  const nowMs = deps.now().getTime();
  const closeMs = run.sessionCloseAt?.getTime() ?? 0;
  const remaining = () => TICK_BUDGET_MS - (Date.now() - startedAt);

  switch (run.status) {
    case "scheduled":
    case "researching":
    case "deciding": {
      if (settings.killSwitch) return setRunStatus(run.id, "skipped", "Kill switch is on");
      if (nowMs >= closeMs - minutes(2)) return setRunStatus(run.id, "failed", "Ran out of time before the close");
      if (run.status === "scheduled") return stageScreen(run.id);
      if (run.status === "researching") return stageResearch(run.id, startedAt + RESEARCH_CUTOFF_MS);
      if (remaining() < DECIDE_MIN_REMAINING_MS) return; // let the next tick start it fresh
      return stageDecide(run.id);
    }
    case "awaiting_approval": {
      const [d] = await db.select().from(decisions).where(eq(decisions.runId, run.id)).orderBy(desc(decisions.id)).limit(1);
      if (!d) return setRunStatus(run.id, "failed", "Decision missing");
      if (settings.killSwitch) {
        await db.update(decisions).set({ approval: "rejected" }).where(eq(decisions.id, d.id));
        return setRunStatus(run.id, "no_trade", "Kill switch is on");
      }
      if (d.approval === "approved") return setRunStatus(run.id, "ready_to_buy");
      if (d.approval === "rejected") return setRunStatus(run.id, "no_trade", "Rejected by you");
      if (d.approval === "pending" && d.approvalDeadline && nowMs >= d.approvalDeadline.getTime()) {
        await db.update(decisions).set({ approval: "expired" }).where(eq(decisions.id, d.id));
        await log("info", "scheduler", "Approval window expired; no trade today.", run.id);
        return setRunStatus(run.id, "no_trade", "Approval window expired");
      }
      return;
    }
    case "ready_to_buy": {
      if (settings.killSwitch) return setRunStatus(run.id, "no_trade", "Kill switch is on");
      if (nowMs >= closeMs) return setRunStatus(run.id, "no_trade", "Missed the buy window");
      if (nowMs >= closeMs - minutes(settings.minutesBeforeCloseToBuy)) await executeBuy(run.id);
      return;
    }
    case "holding":
    case "exiting": {
      // Exits keep running under the kill switch: it stops new risk, it should not strand an open position.
      const client = await tryClient();
      if (!client) return;
      const next = nextSessionAfter(await getMarketSessions(client, run.market), run.sessionCloseAt ?? deps.now());
      if (!next) return warnOnce(`nosession:${run.id}`, "Exit session not found in T212 schedule yet; waiting.", run.id, nowMs);
      const exitFrom = run.mode === "dry" ? next.open.getTime() + minutes(2) : next.open.getTime() - minutes(3);
      if (nowMs >= exitFrom) await executeExit(run.id);
      return;
    }
  }
}

const PRIORITY: Record<string, number> = { holding: 0, exiting: 0, ready_to_buy: 1, awaiting_approval: 2 };

async function snapshotEquity(deps: SchedulerDeps): Promise<void> {
  const acct = await getAccountState(await tryClient());
  await getDb().insert(equitySnapshots).values({ ts: deps.now(), totalValue: acct.totalValue, cash: acct.availableCash, mode: await currentMode() });
}

/** One scheduler pass. Called about once a minute by an external timer; safe to call concurrently (DB lease). */
export async function tick(deps: SchedulerDeps = realClock): Promise<TickResult> {
  const startedAt = Date.now();
  let result: TickResult = { ran: false, skipped: "another tick is running" };
  const got = await withLock("tick", TICK_BUDGET_MS + 60_000, async () => {
    const db = getDb();
    const nowMs = deps.now().getTime();
    const settings = await getSettings();
    const traceOptions = { slowMs: settings.ops.slowJobSeconds * 1000, verbose: settings.ops.verboseLogging };
    await db.insert(schema.settings).values({ key: "_heartbeat", value: nowMs }).onConflictDoUpdate({ target: schema.settings.key, set: { value: nowMs } });

    await recover(nowMs);

    for (const m of MARKETS) {
      try {
        const status = await ensureRun(m, deps);
        await recordEnsure(m, status, nowMs);
        if (status.notable) await warnOnce(`ensure:${m}:${status.text}`, `No ${m} run was created: ${status.text}.`, undefined, nowMs);
      } catch (err) {
        await warnOnce(`ensure:${m}`, `Could not check ${m} schedule: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }

    const active = (await db.select().from(runs).where(notInArray(runs.status, [...TERMINAL_STATUSES]))).sort(
      (a, b) => (PRIORITY[a.status] ?? 3) - (PRIORITY[b.status] ?? 3),
    );
    for (const r of active) {
      try {
        await processRun(r, deps, startedAt);
      } catch (err) {
        await warnOnce(`run:${r.id}`, `Run #${r.id} step failed: ${String(err).slice(0, 200)}`, r.id, nowMs);
      }
    }

    if (Date.now() - startedAt < TICK_BUDGET_MS - 60_000) {
      try {
        if (await every("equity", minutes(settings.ops.equitySnapshotMinutes), nowMs)) {
          await traced("equity-snapshot", () => snapshotEquity(deps), traceOptions);
        }
        // Learning does not depend on having traded: every shortlisted name that gets scored is a
        // labelled example, so the model keeps improving through NO_TRADE days too. It trains as soon
        // as new outcomes land, with the timer as a backstop for rules that depend on elapsed time.
        let newOutcomes = 0;
        if (await every("outcomes", minutes(settings.ops.outcomesIntervalMinutes), nowMs)) {
          const outcomeResult = await traced("score-outcomes", () => scoreOutcomes(), {
            ...traceOptions,
            detail: (scored) => ({ scored }),
            summary: (scored) => `${scored} candidate(s) scored`,
          });
          if (outcomeResult.ok) newOutcomes = outcomeResult.value;
        }
        if (newOutcomes > 0 || (await every("learning", settings.ops.learningIntervalHours * 3_600_000, nowMs))) {
          const learningResult = await traced("learning-cycle", () => runLearningCycle(), {
            ...traceOptions,
            detail: (value) => ({ trained: value.trained, activeRules: value.activeRules }),
            summary: (value) => `${value.trained} outcome(s), ${value.activeRules} active rule(s)`,
          });
          if (learningResult.ok && learningResult.value.trained > 0) {
            const { trained, activeRules } = learningResult.value;
            await log("info", "learning", `Trained on ${trained} new outcome(s); ${activeRules} rule(s) active.`);
          }
        }
        if (await every("retention", 12 * 3_600_000, nowMs)) {
          await traced("retention", () => pruneOperationalData(settings.ops, nowMs), {
            ...traceOptions,
            detail: (value) => ({ logs: value.logs, jobs: value.jobs, equity: value.equity, kv: value.kv }),
            summary: (value) => `${value.logs + value.jobs + value.equity + value.kv} row(s) pruned`,
          });
        }
      } catch (err) {
        await warnOnce("housekeeping", `Housekeeping failed: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }

    // Study last, on whatever budget is left, so building the knowledge base can never delay a
    // trade. A run that is mid-flight gets the tick to itself.
    let studied: number | undefined;
    const studyDeadline = startedAt + STUDY_CUTOFF_MS;
    if (active.length === 0 && Date.now() < studyDeadline - 30_000) {
      try {
        if (await every("study", minutes(settings.quant.studyIntervalMinutes), nowMs)) {
          const studyResult = await traced("study-round", () => studyRound(studyDeadline), {
            ...traceOptions,
            record: (value) => value.ran,
            detail: (value) => ({
              ran: value.ran,
              skipped: value.skipped,
              market: value.market,
              scanned: value.scanned,
              scored: value.scored,
              researched: value.researched,
              skippedKnown: value.skippedKnown,
            }),
            summary: (value) => value.ran ? `${value.scanned} symbol(s) scanned` : value.skipped ?? "idle",
          });
          if (studyResult.ok && studyResult.value.ran) studied = studyResult.value.scanned;
        }
      } catch (err) {
        await warnOnce("study", `Study round failed: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }

    // Then replay history into the model with whatever time is still left. The time check comes
    // first because `every` starts its timer the moment it says yes.
    if (active.length === 0 && Date.now() < studyDeadline - 40_000) {
      try {
        if (await every("backfill", minutes(settings.ops.backfillIntervalMinutes), nowMs)) {
          await traced("backfill-round", () => backfillRound(studyDeadline), {
            ...traceOptions,
            record: (value) => value.ran,
            detail: (value) => ({ ran: value.ran, skipped: value.skipped, symbols: value.symbols, nights: value.nights }),
            summary: (value) => value.ran ? `${value.symbols} symbol(s), ${value.nights} night(s)` : value.skipped ?? "idle",
          });
        }
      } catch (err) {
        await warnOnce("backfill", `Backfill round failed: ${String(err).slice(0, 200)}`, undefined, nowMs);
      }
    }
    result = { ran: true, activeRuns: active.length, studied };
  });
  return got ? result : { ran: false, skipped: "another tick is running" };
}
