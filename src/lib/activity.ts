/**
 * The live activity payload: what the model is doing right now.
 *
 * Shared by the page (so the first paint is never empty) and the polling API (so it stays live),
 * which keeps the two from drifting apart.
 */

import { desc, eq, notInArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getSettings } from "./config";
import { getKv } from "./kv";
import { knowledgeStats, recentlyStudied } from "./quant/knowledge";

const { runs, candidates, eventLog, settings: settingsTable } = schema;
const TERMINAL = ["closed", "no_trade", "blocked", "failed", "skipped"] as const;

/** What each run status means while you are watching it happen. */
const STAGE: Record<string, string> = {
  scheduled: "Waiting to start screening",
  screening: "Screening the universe for tonight's shortlist",
  researching: "Reading headlines and matching historical analogues",
  deciding: "Scoring every candidate and choosing",
  awaiting_approval: "Waiting for you to approve or reject",
  ready_to_buy: "Approved — waiting for the buy window",
  executing: "Placing the order",
  holding: "Holding overnight",
  exiting: "Selling into the open",
  closed: "Finished",
  no_trade: "Finished — nothing cleared the bar",
  blocked: "Blocked by a safety limit",
  failed: "Failed",
  skipped: "Skipped",
};

export interface ActivityEvent {
  id: number;
  ts: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  runId: number | null;
}

export interface StudiedSymbol {
  symbol: string;
  ticker: string;
  name: string | null;
  market: string;
  score: number | null;
  avgScore: number | null;
  observations: number;
  researchedAt: number | null;
  updatedAt: number;
}

export interface ActivityFeedData {
  now: number;
  heartbeatAt: number | null;
  killSwitch: boolean;
  tradingEnabled: boolean;
  continuousResearch: boolean;
  run: {
    id: number;
    market: string;
    mode: string;
    status: string;
    stage: string;
    active: boolean;
    error: string | null;
    tradingDate: string;
    sessionCloseAt: number | null;
    updatedAt: number;
  } | null;
  /** Why each enabled market does or does not have a run right now. */
  scheduling: { market: string; text: string; at: number }[];
  shortlist: { ticker: string; name: string | null; score: number | null; picked: boolean; state: "queued" | "researched" | "failed" }[];
  knowledge: { symbols: number; researched: number; studiedLastHour: number; lastStudiedAt: number | null; recent: StudiedSymbol[] };
  events: ActivityEvent[];
}

export async function getActivityFeed(): Promise<ActivityFeedData> {
  const db = getDb();
  const s = await getSettings();

  // Prefer whatever is in flight; fall back to the most recent run so the page is never blank.
  const active = await db.select().from(runs).where(notInArray(runs.status, [...TERMINAL])).orderBy(desc(runs.id));
  const [run] = active.length > 0 ? active : await db.select().from(runs).orderBy(desc(runs.id)).limit(1);

  const shortlist = run
    ? await db
        .select({
          ticker: candidates.ticker,
          name: candidates.name,
          score: candidates.screenScore,
          researched: candidates.researchSummary,
          picked: candidates.picked,
        })
        .from(candidates)
        .where(eq(candidates.runId, run.id))
        .orderBy(desc(candidates.screenScore))
    : [];

  const events = await db.select().from(eventLog).orderBy(desc(eventLog.id)).limit(120);
  const [heartbeat] = await db.select().from(settingsTable).where(eq(settingsTable.key, "_heartbeat"));
  const stats = await knowledgeStats();
  const studied = await recentlyStudied(14);

  const scheduling: ActivityFeedData["scheduling"] = [];
  for (const m of ["US", "UK"] as const) {
    const k = await getKv<{ text: string; at: number }>(`ensure:${m}`);
    if (k) scheduling.push({ market: m, text: k.value.text, at: k.value.at });
  }

  return {
    now: Date.now(),
    heartbeatAt: typeof heartbeat?.value === "number" ? heartbeat.value : null,
    killSwitch: s.killSwitch,
    tradingEnabled: s.tradingEnabled,
    continuousResearch: s.quant.continuousResearch,
    run: run
      ? {
          id: run.id,
          market: run.market,
          mode: run.mode,
          status: run.status,
          stage: STAGE[run.status] ?? run.status,
          active: !TERMINAL.includes(run.status as (typeof TERMINAL)[number]),
          error: run.error,
          tradingDate: run.tradingDate,
          sessionCloseAt: run.sessionCloseAt?.getTime() ?? null,
          updatedAt: run.updatedAt.getTime(),
        }
      : null,
    scheduling,
    shortlist: shortlist.map((c) => ({
      ticker: c.ticker,
      name: c.name,
      score: c.score,
      picked: c.picked,
      state: c.researched ? (c.researched.startsWith("Research failed") ? "failed" : "researched") : "queued",
    })),
    knowledge: {
      symbols: stats.symbols,
      researched: stats.researched,
      studiedLastHour: stats.studiedLastHour,
      lastStudiedAt: stats.lastStudiedAt?.getTime() ?? null,
      recent: studied.map((k) => ({
        symbol: k.symbol,
        ticker: k.ticker,
        name: k.name,
        market: k.market,
        score: k.screenScore,
        avgScore: k.avgScore,
        observations: k.observations,
        researchedAt: k.researchedAt?.getTime() ?? null,
        updatedAt: k.updatedAt.getTime(),
      })),
    },
    events: events.map((e) => ({ id: e.id, ts: e.ts.getTime(), level: e.level, source: e.source, message: e.message, runId: e.runId })),
  };
}
