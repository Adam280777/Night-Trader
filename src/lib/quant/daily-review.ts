import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getKv, setKv } from "../kv";
import { getModelReport } from "./learn";
import { governanceReport, type ModelScope } from "./governance";

const REVIEW_KEY_PREFIX = "daily-review:";
const REVIEW_INDEX_KEY = "daily-review:index";
const DAY = 86_400_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_STORED_DATES = 31;

export interface ReviewCandidate {
  ticker: string;
  market: "US" | "UK";
  picked: boolean;
  screenScore: number | null;
}

export interface ReviewTrade {
  ticker: string;
  market: "US" | "UK";
  mode: "dry" | "demo" | "live";
  strategy: "overnight" | "intraday_momentum";
  expectedMovePct: number | null;
  actualReturnPct: number | null;
  brokerNetCashPnl: number | null;
}

export interface ReviewAbstention {
  market: "US" | "UK";
  strategy: "overnight" | "intraday_momentum";
  status: string;
  reason: string;
}

export interface ReviewGuardrail {
  market: "US" | "UK";
  strategy: "overnight" | "intraday_momentum";
  note: string;
}

export interface ReviewFreshness {
  source: string;
  observations: number;
  measured: number;
  averageAgeMs: number | null;
  maximumAgeMs: number | null;
}

export interface ReviewFailure {
  source: string;
  message: string;
  at: number;
  kind: "job" | "api_or_provider";
}

export interface ReviewSlippage {
  ticker: string;
  side: "BUY" | "SELL";
  adverseSlippagePct: number;
}

export interface GovernanceComparison {
  scope: ModelScope;
  championVersionId: number;
  comparisonVersionId: number | null;
  outcomes: number;
  calibrationError: number | null;
  comparisonCalibrationError: number | null;
  readyForManualPromotion: boolean;
}

export interface DailyReviewSnapshot {
  date: string;
  totals: {
    consideredCandidates: number;
    trades: number;
    abstentions: number;
    executionOrders: number;
    slippageMeasured: number;
  };
  candidates: ReviewCandidate[];
  trades: ReviewTrade[];
  abstentions: ReviewAbstention[];
  guardrails: ReviewGuardrail[];
  quoteFreshness: ReviewFreshness[];
  failures: ReviewFailure[];
  slippage: ReviewSlippage[];
  model: {
    samples: number;
    calibrationError: number | null;
    governance: GovernanceComparison[];
  };
  unusual: string[];
}

export interface DailyOperationalReview extends DailyReviewSnapshot {
  generatedAt: string;
  updatedAt: string;
  revision: number;
  contentHash: string;
  coverage: {
    consideredCandidates: boolean;
    tradeOutcomes: boolean;
    brokerCashPnl: { measured: number; total: number };
    quoteAge: { measured: number; total: number };
    actualSlippage: { measured: number; totalOrders: number };
    governance: boolean;
  };
}

export interface GenerateDailyReviewOptions {
  /** UTC operational day (YYYY-MM-DD). Defaults to the current UTC day. */
  date?: string;
  now?: Date;
  /** Per-section row cap. Clamped to 1..50. */
  maxItems?: number;
}

const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
const safeDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error("Daily review date must be YYYY-MM-DD");
  }
  return value;
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const contentHash = (snapshot: DailyReviewSnapshot) =>
  createHash("sha256").update(canonical(snapshot)).digest("hex").slice(0, 20);

export function buildDailyOperationalReview(
  snapshot: DailyReviewSnapshot,
  generatedAt: Date,
  previous?: DailyOperationalReview | null,
): DailyOperationalReview {
  const hash = contentHash(snapshot);
  const brokerMeasured = snapshot.trades.filter((trade) => finite(trade.brokerNetCashPnl) && trade.mode !== "dry").length;
  const quoteTotal = snapshot.quoteFreshness.reduce((sum, row) => sum + row.observations, 0);
  const quoteMeasured = snapshot.quoteFreshness.reduce((sum, row) => sum + row.measured, 0);
  return {
    ...snapshot,
    generatedAt: previous?.generatedAt ?? generatedAt.toISOString(),
    updatedAt: generatedAt.toISOString(),
    revision: previous && previous.contentHash !== hash ? previous.revision + 1 : previous?.revision ?? 1,
    contentHash: hash,
    coverage: {
      consideredCandidates: snapshot.candidates.length > 0,
      tradeOutcomes: snapshot.trades.some((trade) => finite(trade.actualReturnPct)),
      brokerCashPnl: { measured: brokerMeasured, total: snapshot.trades.filter((trade) => trade.mode !== "dry").length },
      quoteAge: { measured: quoteMeasured, total: quoteTotal },
      actualSlippage: { measured: snapshot.totals.slippageMeasured, totalOrders: snapshot.totals.executionOrders },
      governance: snapshot.model.governance.length > 0,
    },
  };
}

async function collectSnapshot(date: string, limit: number): Promise<DailyReviewSnapshot> {
  const db = getDb();
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + DAY);
  const [candidateRows, tradeRows, runRows, orderRows, jobRows, eventRows, model, governance, totals] = await Promise.all([
    db
      .select({
        ticker: schema.candidates.ticker,
        market: schema.runs.market,
        picked: schema.candidates.picked,
        screenScore: schema.candidates.screenScore,
      })
      .from(schema.candidates)
      .innerJoin(schema.runs, eq(schema.candidates.runId, schema.runs.id))
      .where(eq(schema.runs.tradingDate, date))
      .orderBy(asc(schema.candidates.id))
      .limit(limit),
    db
      .select({
        ticker: schema.trades.ticker,
        market: schema.runs.market,
        mode: schema.runs.mode,
        strategy: schema.runs.strategy,
        expectedMovePct: schema.decisions.expectedMovePct,
        actualReturnPct: schema.trades.pnlPct,
        brokerNetCashPnl: schema.trades.pnl,
      })
      .from(schema.trades)
      .innerJoin(schema.runs, eq(schema.trades.runId, schema.runs.id))
      .innerJoin(schema.decisions, eq(schema.trades.decisionId, schema.decisions.id))
      .where(eq(schema.runs.tradingDate, date))
      .orderBy(asc(schema.trades.id))
      .limit(limit),
    db
      .select({
        market: schema.runs.market,
        strategy: schema.runs.strategy,
        status: schema.runs.status,
        error: schema.runs.error,
        thesis: schema.decisions.thesis,
        notes: schema.decisions.guardrailNotes,
      })
      .from(schema.runs)
      .leftJoin(schema.decisions, eq(schema.decisions.runId, schema.runs.id))
      .where(eq(schema.runs.tradingDate, date))
      .orderBy(asc(schema.runs.id))
      .limit(limit),
    db
      .select({
        ticker: schema.orders.ticker,
        side: schema.orders.side,
        status: schema.orders.status,
        source: schema.orders.referenceSource,
        quoteAgeMs: schema.orders.quoteAgeMs,
        slippagePct: schema.orders.slippagePct,
      })
      .from(schema.orders)
      .innerJoin(schema.runs, eq(schema.orders.runId, schema.runs.id))
      .where(eq(schema.runs.tradingDate, date))
      .orderBy(asc(schema.orders.id))
      .limit(limit),
    db
      .select()
      .from(schema.jobRuns)
      .where(and(gte(schema.jobRuns.startedAt, from), lt(schema.jobRuns.startedAt, to), eq(schema.jobRuns.ok, false)))
      .orderBy(asc(schema.jobRuns.startedAt))
      .limit(limit),
    db
      .select()
      .from(schema.eventLog)
      .where(and(gte(schema.eventLog.ts, from), lt(schema.eventLog.ts, to)))
      .orderBy(asc(schema.eventLog.ts))
      .limit(limit * 5),
    getModelReport().catch(() => null),
    Promise.all(
      (["shared", "US", "UK"] as ModelScope[]).map((scope) => governanceReport(scope).catch(() => null)),
    ),
    Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(schema.candidates).innerJoin(schema.runs, eq(schema.candidates.runId, schema.runs.id)).where(eq(schema.runs.tradingDate, date)),
      db.select({ n: sql<number>`count(*)` }).from(schema.trades).innerJoin(schema.runs, eq(schema.trades.runId, schema.runs.id)).where(eq(schema.runs.tradingDate, date)),
      db.select({ n: sql<number>`count(*)` }).from(schema.runs).where(and(eq(schema.runs.tradingDate, date), inArray(schema.runs.status, ["no_trade", "blocked", "failed", "skipped"]))),
      db.select({ n: sql<number>`count(*)`, measured: sql<number>`count(${schema.orders.slippagePct})` }).from(schema.orders).innerJoin(schema.runs, eq(schema.orders.runId, schema.runs.id)).where(eq(schema.runs.tradingDate, date)),
    ]).then(([candidateCount, tradeCount, abstentionCount, orderCount]) => ({
      consideredCandidates: Number(candidateCount[0]?.n ?? 0),
      trades: Number(tradeCount[0]?.n ?? 0),
      abstentions: Number(abstentionCount[0]?.n ?? 0),
      executionOrders: Number(orderCount[0]?.n ?? 0),
      slippageMeasured: Number(orderCount[0]?.measured ?? 0),
    })),
  ]);

  const abstentionStatuses = new Set(["no_trade", "blocked", "failed", "skipped"]);
  const abstentions: ReviewAbstention[] = runRows
    .filter((run) => abstentionStatuses.has(run.status))
    .slice(0, limit)
    .map((run) => ({
      market: run.market,
      strategy: run.strategy,
      status: run.status,
      reason: (run.error || run.thesis || "No persisted reason").slice(0, 300),
    }));
  const guardrails = runRows
    .flatMap((run) =>
      (run.notes ?? []).map((note) => ({ market: run.market, strategy: run.strategy, note: String(note).slice(0, 300) })),
    )
    .slice(0, limit);
  const freshnessBySource = new Map<string, { ages: number[]; observations: number }>();
  for (const order of orderRows) {
    const source = order.source?.trim() || "unknown";
    const item = freshnessBySource.get(source) ?? { ages: [], observations: 0 };
    item.observations++;
    if (finite(order.quoteAgeMs)) item.ages.push(order.quoteAgeMs);
    freshnessBySource.set(source, item);
  }
  const quoteFreshness = [...freshnessBySource.entries()].map(([source, item]) => ({
    source,
    observations: item.observations,
    measured: item.ages.length,
    averageAgeMs: item.ages.length ? item.ages.reduce((sum, value) => sum + value, 0) / item.ages.length : null,
    maximumAgeMs: item.ages.length ? Math.max(...item.ages) : null,
  }));
  const providerEvents = eventRows.filter(
    (event) => event.level !== "info" && /(api|provider|quote|fmp|yahoo|fresh|stale|rate|timeout)/i.test(`${event.source} ${event.message}`),
  );
  const failures: ReviewFailure[] = [
    ...jobRows.map((job) => ({
      source: job.job,
      message: (job.error || "Job failed without a stored error").slice(0, 300),
      at: job.startedAt.getTime(),
      kind: "job" as const,
    })),
    ...providerEvents.map((event) => ({
      source: event.source,
      message: event.message.slice(0, 300),
      at: event.ts.getTime(),
      kind: "api_or_provider" as const,
    })),
  ].slice(0, limit);
  const slippage = orderRows
    .filter((order) => finite(order.slippagePct))
    .map((order) => ({ ticker: order.ticker, side: order.side, adverseSlippagePct: Math.max(0, order.slippagePct!) }))
    .slice(0, limit);
  const unusual = [
    ...orderRows
      .filter((order) => ["rejected", "partial", "unknown", "cancelled"].includes(order.status))
      .map((order) => `${order.ticker} ${order.side.toLowerCase()} order ended ${order.status}.`),
    ...tradeRows
      .filter((trade) => finite(trade.actualReturnPct) && Math.abs(trade.actualReturnPct) >= 5)
      .map((trade) => `${trade.ticker} moved ${trade.actualReturnPct! >= 0 ? "+" : ""}${trade.actualReturnPct!.toFixed(2)}%, outside the 5% review threshold.`),
    ...slippage
      .filter((row) => row.adverseSlippagePct >= 1)
      .map((row) => `${row.ticker} ${row.side.toLowerCase()} adverse slippage was ${row.adverseSlippagePct.toFixed(2)}%.`),
    ...providerEvents.map((event) => `${event.source}: ${event.message.slice(0, 200)}`),
  ].slice(0, limit);

  return {
    date,
    totals,
    candidates: candidateRows,
    trades: tradeRows.map((trade) => ({
      ...trade,
      // Dry cash P&L is simulated and must not be presented as broker-authoritative.
      brokerNetCashPnl: trade.mode === "dry" ? null : trade.brokerNetCashPnl,
    })),
    abstentions,
    guardrails,
    quoteFreshness,
    failures,
    slippage,
    model: {
      samples: model?.samples ?? 0,
      calibrationError: model?.calibrationError ?? null,
      governance: governance
        .filter((report): report is NonNullable<typeof report> => report != null)
        .map((report) => ({
          scope: report.scope,
          championVersionId: report.championVersionId,
          comparisonVersionId: report.challengerVersionId,
          outcomes: report.outcomes,
          calibrationError: report.champion.calibrationError,
          comparisonCalibrationError: report.challenger.calibrationError,
          readyForManualPromotion: report.readyForManualPromotion,
        })),
    },
    unusual,
  };
}

/**
 * Generates or updates one bounded report per UTC day. Re-running unchanged input returns the
 * existing report; changed evidence updates the same KV key and increments its revision.
 */
export async function generateDailyOperationalReview(
  options: GenerateDailyReviewOptions = {},
): Promise<DailyOperationalReview> {
  const now = options.now ?? new Date();
  const date = safeDate(options.date ?? now.toISOString().slice(0, 10));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(options.maxItems ?? DEFAULT_LIMIT)));
  const key = `${REVIEW_KEY_PREFIX}${date}`;
  const [snapshot, existing] = await Promise.all([
    collectSnapshot(date, limit),
    getKv<DailyOperationalReview>(key),
  ]);
  const report = buildDailyOperationalReview(snapshot, now, existing?.value);
  if (existing?.value.contentHash === report.contentHash) return existing.value;

  await setKv(key, report);
  const index = (await getKv<string[]>(REVIEW_INDEX_KEY))?.value ?? [];
  const dates = [date, ...index.filter((item) => item !== date)]
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_STORED_DATES);
  await setKv(REVIEW_INDEX_KEY, dates);
  return report;
}

export async function getLatestDailyOperationalReviews(limit = 7): Promise<DailyOperationalReview[]> {
  const bounded = Math.max(1, Math.min(MAX_STORED_DATES, Math.trunc(limit)));
  const dates = ((await getKv<string[]>(REVIEW_INDEX_KEY))?.value ?? []).slice(0, bounded);
  const rows = await Promise.all(dates.map((date) => getKv<DailyOperationalReview>(`${REVIEW_KEY_PREFIX}${date}`)));
  return rows.flatMap((row) => (row ? [row.value] : []));
}
