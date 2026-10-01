/**
 * Is the model any good? Scores its stated probabilities against what happened, and compares its
 * ranking with the simple screener score it is meant to improve on. Both are measured on the same
 * shortlisted nights, so a model that merely echoes the screener shows no edge here.
 */

export interface AccuracyRow {
  /** The engine's calibrated probability that the night clears costs. */
  probability: number;
  /** The screener's heuristic score for the same name. */
  screenScore: number;
  label: boolean;
}

export interface AccuracyReport {
  n: number;
  baseRate: number;
  /** Mean squared error of the stated probabilities (lower is better). */
  brier: number;
  /** Brier score of always predicting the base rate; the model must beat this to add anything. */
  baselineBrier: number;
  /** Chance a randomly chosen winning night is ranked above a losing one (0.5 = no skill). */
  modelAuc: number | null;
  screenerAuc: number | null;
}

/** Mann-Whitney AUC with ties counted as half. */
export function auc(scores: number[], labels: boolean[]): number | null {
  const pos: number[] = [];
  const neg: number[] = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function accuracyOf(rows: AccuracyRow[]): AccuracyReport | null {
  if (rows.length === 0) return null;
  const n = rows.length;
  const baseRate = rows.filter((r) => r.label).length / n;
  let brier = 0;
  let baselineBrier = 0;
  for (const r of rows) {
    const y = r.label ? 1 : 0;
    brier += (r.probability - y) ** 2;
    baselineBrier += (baseRate - y) ** 2;
  }
  const labels = rows.map((r) => r.label);
  return {
    n,
    baseRate,
    brier: brier / n,
    baselineBrier: baselineBrier / n,
    modelAuc: auc(rows.map((r) => r.probability), labels),
    screenerAuc: auc(rows.map((r) => r.screenScore), labels),
  };
}
