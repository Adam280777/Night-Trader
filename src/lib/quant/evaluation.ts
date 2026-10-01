import { accuracyOf, type AccuracyReport, type AccuracyRow } from "./accuracy";
import { mean } from "./stats";

export interface StrategyRiskReport {
  n: number;
  compoundedReturnPct: number;
  maxDrawdownPct: number;
  downsideDeviationPct: number;
  profitFactor: number | null;
  expectancyPct: number;
  bestPct: number;
  worstPct: number;
  winRate: number;
}

/** `returnsPct` must be oldest first because drawdown is path-dependent. */
export function strategyRisk(returnsPct: number[]): StrategyRiskReport | null {
  const values = returnsPct.filter(Number.isFinite);
  if (values.length === 0) return null;

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let gains = 0;
  let losses = 0;
  for (const value of values) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
    if (value > 0) gains += value;
    else losses += Math.abs(value);
  }
  const downside = values.map((value) => Math.min(0, value));

  return {
    n: values.length,
    compoundedReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    downsideDeviationPct: Math.sqrt(mean(downside.map((value) => value * value))),
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? null : 0,
    expectancyPct: mean(values),
    bestPct: Math.max(...values),
    worstPct: Math.min(...values),
    winRate: values.filter((value) => value > 0).length / values.length,
  };
}

export interface ChronologicalAccuracyRow extends AccuracyRow {
  id: number;
  market: "US" | "UK";
  regime?: "unknown" | "calm" | "normal" | "stressed";
}

export interface EvaluationSlice {
  label: string;
  n: number;
  accuracy: AccuracyReport | null;
}

/**
 * Every probability in this report was persisted before its outcome existed. Splitting in ID order
 * makes deterioration visible without fitting thresholds or selecting a favourable date range.
 */
export function chronologicalEvaluation(rows: ChronologicalAccuracyRow[]) {
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  if (ordered.length === 0) return null;
  const midpoint = Math.max(1, Math.floor(ordered.length / 2));
  const slices: EvaluationSlice[] = [
    { label: "All live predictions", n: ordered.length, accuracy: accuracyOf(ordered) },
    { label: "Earlier half", n: midpoint, accuracy: accuracyOf(ordered.slice(0, midpoint)) },
    { label: "Recent half", n: ordered.length - midpoint, accuracy: accuracyOf(ordered.slice(midpoint)) },
    ...(["US", "UK"] as const).map((market) => {
      const marketRows = ordered.filter((row) => row.market === market);
      return { label: market, n: marketRows.length, accuracy: accuracyOf(marketRows) };
    }),
    ...(["calm", "normal", "stressed", "unknown"] as const).map((regime) => {
      const regimeRows = ordered.filter((row) => row.regime === regime);
      return { label: `${regime} volatility`, n: regimeRows.length, accuracy: accuracyOf(regimeRows) };
    }),
  ];
  return { n: ordered.length, slices };
}
