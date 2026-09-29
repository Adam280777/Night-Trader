/** Small, dependency-free statistics used across the quant engine. All functions are pure. */

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Guards every number that reaches the model: NaN/Infinity become a safe default. */
export const finite = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);

export function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

export function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Linear-interpolated quantile. `p` is 0..1. */
export function quantile(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = clamp(p, 0, 1) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const median = (a: number[]) => quantile(a, 0.5);

/** Clip to the given percentile range so one crazy print cannot dominate a mean. */
export function winsorize(a: number[], p = 0.05): number[] {
  if (a.length < 5) return a;
  const lo = quantile(a, p);
  const hi = quantile(a, 1 - p);
  return a.map((x) => clamp(x, lo, hi));
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

export function logit(p: number): number {
  const c = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/** Abramowitz-Stegun 7.1.26 error function; max error ~1.5e-7. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (x: number, mu = 0, sigma = 1) => (sigma <= 0 ? (x >= mu ? 1 : 0) : 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2))));

/** Mean of a normal distribution conditioned on being above `t` (expected size of a win). */
export function normalMeanAbove(mu: number, sigma: number, t: number): number {
  if (sigma <= 0) return mu;
  const a = (t - mu) / sigma;
  const tail = 1 - normalCdf(a);
  if (tail < 1e-6) return Math.max(mu, t);
  const pdf = Math.exp(-0.5 * a * a) / Math.sqrt(2 * Math.PI);
  return mu + (sigma * pdf) / tail;
}

/** Mean of a normal distribution conditioned on being below `t` (expected size of a loss). */
export function normalMeanBelow(mu: number, sigma: number, t: number): number {
  if (sigma <= 0) return mu;
  const a = (t - mu) / sigma;
  const head = normalCdf(a);
  if (head < 1e-6) return Math.min(mu, t);
  const pdf = Math.exp(-0.5 * a * a) / Math.sqrt(2 * Math.PI);
  return mu - (sigma * pdf) / head;
}

/**
 * Posterior mean of a binomial rate under a Beta prior. Keeps small samples honest:
 * 2 wins out of 2 becomes ~0.6 rather than 1.0.
 */
export const shrunkRate = (wins: number, n: number, priorRate = 0.5, priorWeight = 8) =>
  (wins + priorRate * priorWeight) / (n + priorWeight);

/** Shrink a sample mean toward a prior with a pseudo-count. */
export const shrunkMean = (sampleMean: number, n: number, prior: number, priorWeight: number) =>
  (sampleMean * n + prior * priorWeight) / (n + priorWeight);

/** Standard error of a proportion. */
export const proportionSe = (p: number, n: number) => (n > 0 ? Math.sqrt((p * (1 - p)) / n) : 0.5);

/**
 * Two-sided p-value that an observed win count differs from `p0`, via the normal approximation
 * with a continuity correction. Decides whether a mined pattern is worth keeping as a lesson.
 */
export function binomialPValue(wins: number, n: number, p0 = 0.5): number {
  if (n === 0) return 1;
  const sd = Math.sqrt(n * p0 * (1 - p0));
  if (sd === 0) return 1;
  const z = (Math.abs(wins - n * p0) - 0.5) / sd;
  return clamp(2 * (1 - normalCdf(Math.max(0, z))), 0, 1);
}

/** Welford accumulator so feature standardisation updates online without storing history. */
export interface RunningStat {
  n: number;
  mean: number;
  m2: number;
}

export const newRunningStat = (): RunningStat => ({ n: 0, mean: 0, m2: 0 });

export function pushStat(s: RunningStat, x: number): RunningStat {
  if (!Number.isFinite(x)) return s;
  const n = s.n + 1;
  const delta = x - s.mean;
  const m = s.mean + delta / n;
  return { n, mean: m, m2: s.m2 + delta * (x - m) };
}

export const statStd = (s: RunningStat) => (s.n > 1 ? Math.sqrt(s.m2 / (s.n - 1)) : 0);

/** Simple moving average of the last `n` values. */
export const sma = (a: number[], n: number) => (a.length ? mean(a.slice(-n)) : 0);

/** Wilder-style RSI over `period` closes; 50 when there is not enough history. */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  return (100 * gain) / (gain + loss);
}

/** Ordinary least-squares slope of y on x, used for beta against the index. */
export function slope(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}
