/**
 * Conditional historical analogues.
 *
 * Rather than asking "what does this stock usually do overnight", this asks the sharper question:
 * "on the historical days where this stock's setup looked like today's, what did it actually do
 * between the close and the next open?" It is a kernel-weighted nearest-neighbour estimate over the
 * name's own history, so it needs no training data, no API and no assumptions about linearity, and
 * it naturally captures effects the linear model cannot (for example that a stock only gaps up when
 * it closes strongly *and* on heavy volume).
 */

import type { Bar } from "../market/data";
import { clamp, finite, mean, quantile, std, winsorize } from "./stats";

/** The setup axes an analogue match is computed over. */
const AXES = ["closeLocation", "relVolume", "ret1d", "ret5d", "volatility", "vsSma20"] as const;
type Axis = (typeof AXES)[number];

/** Relative importance of each axis when measuring how alike two days are. */
const AXIS_WEIGHT: Record<Axis, number> = {
  closeLocation: 1.4,
  relVolume: 1.2,
  ret1d: 1.3,
  ret5d: 0.8,
  volatility: 0.9,
  vsSma20: 0.7,
};

export type Setup = Record<Axis, number>;

const LOOKBACK = 60;

/** Setup of the bar at index `i`, using only information available at that day's close. */
function setupAt(bars: Bar[], i: number): Setup | null {
  if (i < LOOKBACK) return null;
  const b = bars[i];
  const range = b.high - b.low;
  const prior = bars.slice(i - LOOKBACK, i);
  const avgVol = mean(prior.map((x) => x.volume));
  const atr = mean(bars.slice(i - 13, i + 1).map((x) => ((x.high - x.low) / x.close) * 100)) || 1;
  const sma20 = mean(bars.slice(i - 19, i + 1).map((x) => x.close));
  const ret = (n: number) => (bars[i - n]?.close > 0 ? (b.close / bars[i - n].close - 1) * 100 : 0);

  return {
    closeLocation: finite(range > 0 ? (b.close - b.low) / range : 0.5, 0.5),
    relVolume: finite(avgVol > 0 ? Math.log(clamp(b.volume / avgVol, 0.1, 10)) : 0),
    ret1d: finite(clamp(ret(1) / atr, -4, 4)),
    ret5d: finite(clamp(ret(5) / (atr * 2.2), -4, 4)),
    volatility: finite(clamp(atr, 0, 20)),
    vsSma20: finite(sma20 > 0 ? clamp(((b.close / sma20 - 1) * 100) / Math.max(1, atr), -4, 4) : 0),
  };
}

/** Today's setup, derived from the same code path as the historical ones so they stay comparable. */
export function currentSetup(bars: Bar[]): Setup | null {
  return setupAt(bars, bars.length - 1);
}

export interface AnalogueResult {
  /** Effective sample size (sum of kernel weights). */
  samples: number;
  /** Weighted mean overnight return in percent. */
  meanPct: number;
  medianPct: number;
  sigmaPct: number;
  /** Weighted share of analogues with a positive overnight move. */
  hitRate: number;
  p10Pct: number;
  p90Pct: number;
  /** The matched overnight returns and their kernel weights, so the result can be persisted. */
  returns: number[];
  weights: number[];
  /** Weighted probability the overnight move exceeded a given threshold. */
  probAbove: (thresholdPct: number) => number;
  /** Mean of the analogues that exceeded the threshold, and of those that did not. */
  conditionalMeans: (thresholdPct: number) => { win: number; loss: number };
}

/** The persistable part of an analogue result. */
export type AnalogueSnapshot = { returns: number[]; weights: number[] };

export const serializeAnalogue = (a: AnalogueResult): AnalogueSnapshot => ({
  returns: a.returns.map((x) => Number(x.toFixed(4))),
  weights: a.weights.map((x) => Number(x.toFixed(4))),
});

/** Rebuilds a full result (including its closures) from stored data. */
export function deserializeAnalogue(snap: unknown): AnalogueResult | null {
  const s = snap as Partial<AnalogueSnapshot> | null;
  if (!s || !Array.isArray(s.returns) || !Array.isArray(s.weights)) return null;
  if (s.returns.length === 0 || s.returns.length !== s.weights.length) return null;
  return buildResult(s.returns.map(Number), s.weights.map(Number));
}

/** Unconditional fallback when there is not enough history to condition on anything. */
export function unconditionalAnalogue(gaps: number[]): AnalogueResult | null {
  if (gaps.length < 20) return null;
  const g = winsorize(gaps, 0.02);
  const w = g.map(() => 1);
  return buildResult(g, w);
}

function buildResult(returns: number[], weights: number[]): AnalogueResult {
  const total = weights.reduce((s, x) => s + x, 0) || 1;
  const m = returns.reduce((s, r, i) => s + r * weights[i], 0) / total;
  const variance = returns.reduce((s, r, i) => s + weights[i] * (r - m) ** 2, 0) / total;
  const sigma = Math.sqrt(Math.max(0, variance));

  const probAbove = (t: number) => clamp(returns.reduce((s, r, i) => s + (r > t ? weights[i] : 0), 0) / total, 0, 1);
  const conditionalMeans = (t: number) => {
    let wSum = 0;
    let wTot = 0;
    let lSum = 0;
    let lTot = 0;
    for (const [i, r] of returns.entries()) {
      if (r > t) {
        wSum += r * weights[i];
        wTot += weights[i];
      } else {
        lSum += r * weights[i];
        lTot += weights[i];
      }
    }
    return { win: wTot > 0 ? wSum / wTot : Math.max(m, t), loss: lTot > 0 ? lSum / lTot : Math.min(m, t) };
  };

  return {
    samples: total,
    meanPct: finite(m),
    medianPct: finite(quantile(returns, 0.5)),
    sigmaPct: finite(sigma, 1),
    hitRate: probAbove(0),
    p10Pct: finite(quantile(returns, 0.1)),
    p90Pct: finite(quantile(returns, 0.9)),
    returns,
    weights,
    probAbove,
    conditionalMeans,
  };
}

/**
 * Kernel-weighted analogues of today's setup.
 *
 * `bars` must be oldest-first daily bars; at least ~150 are needed for a useful result.
 */
export function findAnalogues(bars: Bar[], minEffective = 12): AnalogueResult | null {
  if (bars.length < LOOKBACK + 60) return null;
  const today = currentSetup(bars);
  if (!today) return null;

  const history: { setup: Setup; overnightPct: number }[] = [];
  for (let i = LOOKBACK; i < bars.length - 1; i++) {
    const s = setupAt(bars, i);
    const nextOpen = bars[i + 1].open;
    if (!s || !(nextOpen > 0) || !(bars[i].close > 0)) continue;
    history.push({ setup: s, overnightPct: (nextOpen / bars[i].close - 1) * 100 });
  }
  if (history.length < 60) return null;

  // Standardise each axis over this stock's own history so the distance is scale-free.
  const scale = {} as Record<Axis, number>;
  for (const a of AXES) {
    const s = std(history.map((h) => h.setup[a]));
    scale[a] = s > 1e-6 ? s : 1;
  }

  const distances = history.map((h) => {
    let d2 = 0;
    for (const a of AXES) d2 += AXIS_WEIGHT[a] * ((h.setup[a] - today[a]) / scale[a]) ** 2;
    return Math.sqrt(d2 / AXES.length);
  });

  // Bandwidth adapts to the data: use the distance at which we already have enough neighbours.
  const sorted = [...distances].sort((a, b) => a - b);
  const target = clamp(Math.round(history.length * 0.15), 25, 80);
  const bandwidth = Math.max(0.25, sorted[Math.min(target, sorted.length - 1)]);

  const weights = distances.map((d) => Math.exp(-0.5 * (d / bandwidth) ** 2));
  const keep = weights
    .map((w, i) => ({ w, i }))
    .filter((x) => x.w > 0.05)
    .sort((a, b) => b.w - a.w)
    .slice(0, 120);

  const effective = keep.reduce((s, x) => s + x.w, 0);
  if (effective < minEffective) return null;

  const returns = winsorize(keep.map((x) => history[x.i].overnightPct), 0.02);
  return buildResult(returns, keep.map((x) => x.w));
}
