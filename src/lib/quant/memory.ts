import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb, schema } from "../db";
const { trades, decisions, lessons, candidates, runs, orders, modelEvidence } = schema;

export interface PerfStats {
  closedTrades: number;
  winRate: number | null;
  avgPnlPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  totalPnl: number;
  byConfidence: { bucket: string; n: number; winRate: number; avgPnlPct: number }[];
  byMarket: { market: string; n: number; winRate: number; avgPnlPct: number }[];
  /** Overnight return of the shortlist as a whole vs what we picked: is the model adding value over the screener? */
  shortlistAvgOvernightPct: number | null;
  pickedAvgOvernightPct: number | null;
  recent: { date: string; ticker: string; pnlPct: number | null; confidence: number | null }[];
}

const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sum = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) : null);

export type AttributionStrategy = "overnight" | "intraday_momentum";
export type AttributionEvidence = "model_selected" | "intraday_rules" | "exploration_override";
export type ExecutionEvidenceMode = "dry" | "demo" | "live";

export interface AttributionOrderInput {
  side: "BUY" | "SELL";
  spreadPct: number | null;
  slippagePct: number | null;
  filledQuantity?: number | null;
}

export interface AttributionInput {
  date: string;
  market: "US" | "UK";
  mode: ExecutionEvidenceMode;
  strategy: AttributionStrategy;
  forced: boolean;
  pnl: number | null;
  pnlPct: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  orders?: AttributionOrderInput[];
  /** Optional persisted components. They are never inferred unless the derivation is exact. */
  grossPriceReturnPct?: number | null;
  spreadCostPct?: number | null;
  ukStampDutyPct?: number | null;
  estimatedCostPct?: number | null;
  adverseSlippagePct?: number | null;
  fxImpactPct?: number | null;
  benchmarkReturnPct?: number | null;
  selectionReturnPct?: number | null;
  instrumentCurrency?: string | null;
  accountCurrency?: string | null;
  grossPnl?: number | null;
  estimatedSpreadCost?: number | null;
  stampDutyCost?: number | null;
  slippageCost?: number | null;
  fxImpact?: number | null;
}

export interface AttributionCoverage {
  grossPriceReturn: number;
  observedSpread: number;
  spreadCost: number;
  ukStampDuty: number;
  estimatedCosts: number;
  adverseSlippage: number;
  fxImpact: number;
  brokerNetCashPnl: number;
  benchmark: number;
  stockSelection: number;
  grossPnl: number;
  estimatedSpreadCost: number;
  stampDutyCost: number;
  slippageCost: number;
  fxImpactCash: number;
}

export interface DailyAttribution {
  date: string;
  market: "US" | "UK";
  evidenceMode: ExecutionEvidenceMode;
  strategy: AttributionStrategy;
  selectionEvidence: AttributionEvidence;
  accountCurrency: string | null;
  trades: number;
  avgGrossPriceReturnPct: number | null;
  avgObservedSpreadPct: number | null;
  avgSpreadCostPct: number | null;
  avgUkStampDutyPct: number | null;
  avgEstimatedCostPct: number | null;
  avgActualAdverseSlippagePct: number | null;
  avgFxImpactPct: number | null;
  totalBrokerNetCashPnl: number | null;
  totalSimulatedNetCashPnl: number | null;
  avgMarketDirectionContributionPct: number | null;
  avgStockSelectionContributionPct: number | null;
  totalGrossPnl: number | null;
  totalEstimatedSpreadCost: number | null;
  totalStampDutyCost: number | null;
  totalSlippageCost: number | null;
  totalFxImpact: number | null;
  coverage: AttributionCoverage;
  /** Compatibility aliases for older consumers; prefer the explicit component fields above. */
  evidenceType: AttributionEvidence;
  avgRecordedReturnPct: number | null;
  totalAfterCostPnl: number | null;
  cashPnlTrades: number;
}

export interface ShadowAttribution {
  date: string;
  market: "US" | "UK";
  evidenceMode: "shadow";
  strategy: "overnight";
  modelVersionId: number;
  observations: number;
  avgExpectedAfterCostPct: number | null;
  avgActualAfterCostPct: number | null;
}

export interface PerformanceAttribution {
  execution: DailyAttribution[];
  shadow: ShadowAttribution[];
  evidenceCoverage: {
    live: "trade_execution";
    demo: "trade_execution";
    dry: "simulated_trade";
    backfill: "unavailable";
    shadow: "dedicated_model_evidence";
  };
}

const evidenceType = (row: AttributionInput): AttributionEvidence =>
  row.forced ? "exploration_override" : row.strategy === "overnight" ? "model_selected" : "intraday_rules";

interface NormalisedAttribution {
  recordedReturn: number | null;
  gross: number | null;
  observedSpread: number | null;
  spreadCost: number | null;
  stampDuty: number | null;
  estimatedCost: number | null;
  adverseSlippage: number | null;
  fxImpact: number | null;
  brokerPnl: number | null;
  simulatedPnl: number | null;
  benchmark: number | null;
  selection: number | null;
  grossPnl: number | null;
  estimatedSpreadCost: number | null;
  stampDutyCost: number | null;
  slippageCost: number | null;
  fxImpactCash: number | null;
}

function normaliseAttribution(row: AttributionInput): NormalisedAttribution {
  const derivedGross =
    finite(row.entryPrice) && row.entryPrice > 0 && finite(row.exitPrice)
      ? (row.exitPrice / row.entryPrice - 1) * 100
      : null;
  const gross = finite(row.grossPriceReturnPct) ? row.grossPriceReturnPct : derivedGross;
  const measuredSpreads = (row.orders ?? []).map((order) => order.spreadPct).filter(finite);
  const measuredSlippage = (row.orders ?? []).map((order) => order.slippagePct).filter(finite);
  const observedSpread = avg(measuredSpreads);
  const adverseSlippage = finite(row.adverseSlippagePct)
    ? row.adverseSlippagePct
    : measuredSlippage.length
      ? measuredSlippage.reduce((total, value) => total + Math.max(0, value), 0)
      : null;
  // Dry exits persist net simulated return. Gross minus net is therefore an exact aggregate estimate,
  // but its spread/stamp/FX subcomponents were not historically recorded and remain unknown.
  const estimatedCost =
    finite(row.estimatedCostPct)
      ? row.estimatedCostPct
      : row.mode === "dry" && finite(gross) && finite(row.pnlPct)
        ? gross - row.pnlPct
        : null;
  const benchmark = finite(row.benchmarkReturnPct) ? row.benchmarkReturnPct : null;
  return {
    recordedReturn: finite(row.pnlPct) ? row.pnlPct : null,
    gross,
    observedSpread,
    spreadCost: finite(row.spreadCostPct) ? row.spreadCostPct : null,
    stampDuty: finite(row.ukStampDutyPct) ? row.ukStampDutyPct : null,
    estimatedCost,
    adverseSlippage,
    fxImpact: finite(row.fxImpactPct) ? row.fxImpactPct : null,
    brokerPnl: row.mode !== "dry" && finite(row.pnl) ? row.pnl : null,
    simulatedPnl: row.mode === "dry" && finite(row.pnl) ? row.pnl : null,
    benchmark,
    selection: finite(row.selectionReturnPct) ? row.selectionReturnPct : finite(gross) && finite(benchmark) ? gross - benchmark : null,
    grossPnl: finite(row.grossPnl) ? row.grossPnl : null,
    estimatedSpreadCost: finite(row.estimatedSpreadCost) ? row.estimatedSpreadCost : null,
    stampDutyCost: finite(row.stampDutyCost) ? row.stampDutyCost : null,
    slippageCost: finite(row.slippageCost) ? row.slippageCost : null,
    fxImpactCash: finite(row.fxImpact) ? row.fxImpact : null,
  };
}

/** Keeps live/demo/dry evidence in separate groups and leaves unavailable components explicitly null. */
export function summariseDailyAttribution(rows: AttributionInput[]): DailyAttribution[] {
  const groups = new Map<string, { row: AttributionInput; values: NormalisedAttribution[] }>();
  for (const row of rows) {
    const selection = evidenceType(row);
    const key = `${row.date}:${row.market}:${row.mode}:${row.strategy}:${selection}:${row.accountCurrency ?? "unknown"}`;
    const group = groups.get(key) ?? { row, values: [] };
    group.values.push(normaliseAttribution(row));
    groups.set(key, group);
  }
  const values = (rows: NormalisedAttribution[], key: keyof NormalisedAttribution) =>
    rows.map((row) => row[key]).filter(finite);
  return [...groups.values()]
    .map(({ row, values: rows }) => {
      const component = (key: keyof NormalisedAttribution) => values(rows, key);
      const gross = component("gross");
      const recordedReturn = component("recordedReturn");
      const observedSpread = component("observedSpread");
      const spreadCost = component("spreadCost");
      const stampDuty = component("stampDuty");
      const estimatedCost = component("estimatedCost");
      const adverseSlippage = component("adverseSlippage");
      const fxImpact = component("fxImpact");
      const brokerPnl = component("brokerPnl");
      const simulatedPnl = component("simulatedPnl");
      const benchmark = component("benchmark");
      const selection = component("selection");
      const grossPnl = component("grossPnl");
      const estimatedSpreadCost = component("estimatedSpreadCost");
      const stampDutyCost = component("stampDutyCost");
      const slippageCost = component("slippageCost");
      const fxImpactCash = component("fxImpactCash");
      return {
        date: row.date,
        market: row.market,
        evidenceMode: row.mode,
        strategy: row.strategy,
        selectionEvidence: evidenceType(row),
        accountCurrency: row.accountCurrency ?? null,
        trades: rows.length,
        avgGrossPriceReturnPct: avg(gross),
        avgObservedSpreadPct: avg(observedSpread),
        avgSpreadCostPct: avg(spreadCost),
        avgUkStampDutyPct: avg(stampDuty),
        avgEstimatedCostPct: avg(estimatedCost),
        avgActualAdverseSlippagePct: avg(adverseSlippage),
        avgFxImpactPct: avg(fxImpact),
        totalBrokerNetCashPnl: sum(brokerPnl),
        totalSimulatedNetCashPnl: sum(simulatedPnl),
        avgMarketDirectionContributionPct: avg(benchmark),
        avgStockSelectionContributionPct: avg(selection),
        totalGrossPnl: sum(grossPnl),
        totalEstimatedSpreadCost: sum(estimatedSpreadCost),
        totalStampDutyCost: sum(stampDutyCost),
        totalSlippageCost: sum(slippageCost),
        totalFxImpact: sum(fxImpactCash),
        evidenceType: evidenceType(row),
        avgRecordedReturnPct: avg(recordedReturn),
        totalAfterCostPnl: sum(row.mode === "dry" ? simulatedPnl : brokerPnl),
        cashPnlTrades: row.mode === "dry" ? simulatedPnl.length : brokerPnl.length,
        coverage: {
          grossPriceReturn: gross.length,
          observedSpread: observedSpread.length,
          spreadCost: spreadCost.length,
          ukStampDuty: stampDuty.length,
          estimatedCosts: estimatedCost.length,
          adverseSlippage: adverseSlippage.length,
          fxImpact: fxImpact.length,
          brokerNetCashPnl: brokerPnl.length,
          benchmark: benchmark.length,
          stockSelection: selection.length,
          grossPnl: grossPnl.length,
          estimatedSpreadCost: estimatedSpreadCost.length,
          stampDutyCost: stampDutyCost.length,
          slippageCost: slippageCost.length,
          fxImpactCash: fxImpactCash.length,
        },
      };
    })
    .sort((a, b) =>
      b.date.localeCompare(a.date) ||
      a.market.localeCompare(b.market) ||
      a.evidenceMode.localeCompare(b.evidenceMode) ||
      a.strategy.localeCompare(b.strategy) ||
      a.selectionEvidence.localeCompare(b.selectionEvidence),
    );
}

type OptionalTradeColumns = Partial<Record<
  "grossPriceReturnPct" | "spreadCostPct" | "ukStampDutyPct" | "estimatedCostPct" | "adverseSlippagePct" | "fxImpactPct" |
  "benchmarkReturnPct" | "selectionReturnPct" | "instrumentCurrency" | "accountCurrency" | "grossPnl" |
  "estimatedSpreadCost" | "stampDutyCost" | "slippageCost" | "fxImpact",
  AnySQLiteColumn
>>;

function optionalTradeColumns(): OptionalTradeColumns {
  const source = trades as unknown as Record<string, AnySQLiteColumn | undefined>;
  return Object.fromEntries(
    [
      "grossPriceReturnPct", "spreadCostPct", "ukStampDutyPct", "estimatedCostPct", "adverseSlippagePct", "fxImpactPct",
      "benchmarkReturnPct", "selectionReturnPct", "instrumentCurrency", "accountCurrency", "grossPnl",
      "estimatedSpreadCost", "stampDutyCost", "slippageCost", "fxImpact",
    ]
      .filter((key) => source[key] != null)
      .map((key) => [key, source[key]]),
  ) as OptionalTradeColumns;
}

/** Execution attribution is sourced only from closed trades and their own execution orders. */
export async function getDailyAfterCostAttribution(): Promise<DailyAttribution[]> {
  const optional = optionalTradeColumns();
  const selectedRows = await getDb()
    .select({
      id: trades.id,
      runId: trades.runId,
      date: runs.tradingDate,
      market: runs.market,
      mode: runs.mode,
      strategy: runs.strategy,
      forced: decisions.forced,
      pnl: trades.pnl,
      pnlPct: trades.pnlPct,
      entryPrice: trades.entryPrice,
      exitPrice: trades.exitPrice,
      ...optional,
    })
    .from(trades)
    .innerJoin(decisions, eq(trades.decisionId, decisions.id))
    .innerJoin(runs, eq(trades.runId, runs.id))
    .where(eq(trades.status, "closed"));
  type SelectedAttribution = AttributionInput & {
    id: number;
    runId: number;
  };
  const rows = selectedRows as unknown as SelectedAttribution[];
  const runIds = [...new Set(rows.map((row) => row.runId))];
  const orderRows = runIds.length
    ? await getDb()
        .select({
          runId: orders.runId,
          side: orders.side,
          spreadPct: orders.spreadPct,
          slippagePct: orders.slippagePct,
          filledQuantity: orders.filledQuantity,
        })
        .from(orders)
        .where(and(eq(orders.status, "filled"), inArray(orders.runId, runIds)))
    : [];
  const byRun = new Map<number, AttributionOrderInput[]>();
  for (const order of orderRows) {
    if (order.runId == null || !runIds.includes(order.runId)) continue;
    byRun.set(order.runId, [...(byRun.get(order.runId) ?? []), order]);
  }
  return summariseDailyAttribution(
    rows.map((row) => ({
      ...row,
      orders: byRun.get(row.runId) ?? [],
      grossPriceReturnPct: row.grossPriceReturnPct ?? null,
      spreadCostPct: row.spreadCostPct ?? null,
      ukStampDutyPct: row.ukStampDutyPct ?? null,
      estimatedCostPct: row.estimatedCostPct ?? null,
      adverseSlippagePct: row.adverseSlippagePct ?? null,
      fxImpactPct: row.fxImpactPct ?? null,
      benchmarkReturnPct: row.benchmarkReturnPct ?? null,
      selectionReturnPct: row.selectionReturnPct ?? null,
      instrumentCurrency: row.instrumentCurrency ?? null,
      accountCurrency: row.accountCurrency ?? null,
      grossPnl: row.grossPnl ?? null,
      estimatedSpreadCost: row.estimatedSpreadCost ?? null,
      stampDutyCost: row.stampDutyCost ?? null,
      slippageCost: row.slippageCost ?? null,
      fxImpact: row.fxImpact ?? null,
    })),
  );
}

/** Shadow evidence never enters execution attribution. */
export async function getShadowAttribution(): Promise<ShadowAttribution[]> {
  const rows = await getDb()
    .select({
      date: runs.tradingDate,
      market: modelEvidence.market,
      modelVersionId: modelEvidence.modelVersionId,
      expected: modelEvidence.expectedAfterCostPct,
      actual: modelEvidence.actualAfterCostPct,
    })
    .from(modelEvidence)
    .innerJoin(runs, eq(modelEvidence.runId, runs.id))
    .where(eq(modelEvidence.kind, "shadow"));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.date}:${row.market}:${row.modelVersionId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .map((group) => ({
      date: group[0].date,
      market: group[0].market,
      evidenceMode: "shadow" as const,
      strategy: "overnight" as const,
      modelVersionId: group[0].modelVersionId,
      observations: group.length,
      avgExpectedAfterCostPct: avg(group.map((row) => row.expected).filter(finite)),
      avgActualAfterCostPct: avg(group.map((row) => row.actual).filter(finite)),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.market.localeCompare(b.market) || b.modelVersionId - a.modelVersionId);
}

export async function getPerformanceAttribution(): Promise<PerformanceAttribution> {
  const [execution, shadow] = await Promise.all([getDailyAfterCostAttribution(), getShadowAttribution().catch(() => [])]);
  return {
    execution,
    shadow,
    evidenceCoverage: {
      live: "trade_execution",
      demo: "trade_execution",
      dry: "simulated_trade",
      backfill: "unavailable",
      shadow: "dedicated_model_evidence",
    },
  };
}

export async function getPerformanceStats(): Promise<PerfStats> {
  const db = getDb();
  const rows = await db
    .select({
      pnl: trades.pnl,
      pnlPct: trades.pnlPct,
      ticker: trades.ticker,
      exitAt: trades.exitAt,
      confidence: decisions.confidence,
      market: runs.market,
      date: runs.tradingDate,
    })
    .from(trades)
    .innerJoin(decisions, eq(trades.decisionId, decisions.id))
    .innerJoin(runs, eq(trades.runId, runs.id))
    .where(and(eq(trades.status, "closed"), isNotNull(trades.pnlPct)))
    .orderBy(desc(trades.exitAt));

  const pcts = rows.map((r) => r.pnlPct!);
  const wins = pcts.filter((p) => p > 0);
  const losses = pcts.filter((p) => p <= 0);

  const group = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, number[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.pnlPct!]);
    return [...m.entries()].map(([k, v]) => ({
      key: k,
      n: v.length,
      winRate: v.filter((x) => x > 0).length / v.length,
      avgPnlPct: avg(v)!,
    }));
  };

  const bucket = (c: number | null) => (c == null ? "unknown" : c >= 0.8 ? "80-100%" : c >= 0.65 ? "65-80%" : "<65%");

  const cand = await db
    .select({ r: candidates.overnightReturnPct, picked: candidates.picked })
    .from(candidates)
    .where(isNotNull(candidates.overnightReturnPct));

  return {
    closedTrades: rows.length,
    winRate: rows.length ? wins.length / rows.length : null,
    avgPnlPct: avg(pcts),
    avgWinPct: avg(wins),
    avgLossPct: avg(losses),
    totalPnl: rows.reduce((s, r) => s + (r.pnl ?? 0), 0),
    byConfidence: group((r) => bucket(r.confidence)).map((g) => ({ bucket: g.key, n: g.n, winRate: g.winRate, avgPnlPct: g.avgPnlPct })),
    byMarket: group((r) => r.market).map((g) => ({ market: g.key, n: g.n, winRate: g.winRate, avgPnlPct: g.avgPnlPct })),
    shortlistAvgOvernightPct: avg(cand.map((c) => c.r!)),
    pickedAvgOvernightPct: avg(cand.filter((c) => c.picked).map((c) => c.r!)),
    recent: rows.slice(0, 10).map((r) => ({ date: r.date, ticker: r.ticker, pnlPct: r.pnlPct, confidence: r.confidence })),
  };
}

/** Newest active lessons first. With few lessons we include all; the meta-review job keeps the set small. */
export async function getActiveLessons(limit = 25) {
  return getDb().select().from(lessons).where(eq(lessons.active, true)).orderBy(desc(lessons.createdAt)).limit(limit);
}

/** A compact plain-text summary of the track record, used by the dashboard chat. */
export function formatPerformanceSummary(stats: PerfStats, ls: { text: string; tags: string[] }[]): string {
  const pct = (x: number | null) => (x == null ? "n/a" : `${x.toFixed(2)}%`);
  const lines: string[] = ["## Track record"];
  if (stats.closedTrades === 0) {
    lines.push("No closed trades yet.");
  } else {
    lines.push(
      `Closed trades: ${stats.closedTrades}, win rate ${((stats.winRate ?? 0) * 100).toFixed(0)}%, avg ${pct(stats.avgPnlPct)} (wins ${pct(stats.avgWinPct)}, losses ${pct(stats.avgLossPct)}), total P&L ${stats.totalPnl.toFixed(2)}.`,
    );
    for (const b of stats.byConfidence) lines.push(`- Confidence ${b.bucket}: ${b.n} trades, win ${(b.winRate * 100).toFixed(0)}%, avg ${pct(b.avgPnlPct)}`);
    for (const m of stats.byMarket) lines.push(`- ${m.market}: ${m.n} trades, win ${(m.winRate * 100).toFixed(0)}%, avg ${pct(m.avgPnlPct)}`);
    if (stats.shortlistAvgOvernightPct != null && stats.pickedAvgOvernightPct != null) {
      lines.push(
        `Shortlist average overnight return ${pct(stats.shortlistAvgOvernightPct)} vs picks ${pct(stats.pickedAvgOvernightPct)} (is the engine beating its own screener?).`,
      );
    }
    lines.push("Last trades: " + stats.recent.map((r) => `${r.date} ${r.ticker} ${pct(r.pnlPct)}`).join("; "));
  }
  lines.push("", "## Rules learned from outcomes");
  if (ls.length === 0) lines.push("(none yet)");
  for (const l of ls) lines.push(`- ${l.text}${l.tags.length ? ` [${l.tags.join(", ")}]` : ""}`);
  return lines.join("\n");
}
