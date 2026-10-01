import type { IntradaySettings } from "../config";
import type { Bar } from "../market/data";

export interface IntradaySignal {
  symbol: string;
  score: number;
  confidence: number;
  expectedMovePct: number;
  price: number;
  momentumPct: number;
  breakoutPct: number;
  relativeVolume: number;
  vwap: number;
  emaFast: number;
  emaSlow: number;
  reason: string;
}

const pct = (value: number) => value * 100;

function ema(values: number[], period: number): number {
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((value, next) => next * alpha + value * (1 - alpha), values[0]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Pure, deterministic signal calculation so live and tests use exactly the same rules. */
export function analyseIntraday(symbol: string, bars: Bar[], settings: IntradaySettings): IntradaySignal | null {
  if (bars.length < settings.minBars) return null;
  const usable = bars.filter((bar) => bar.close > 0 && bar.high > 0 && bar.low > 0);
  if (usable.length < settings.minBars) return null;

  const closes = usable.map((bar) => bar.close);
  const current = usable.at(-1)!;
  const momentumLookback = Math.min(4, usable.length - 1);
  const momentumPct = pct(current.close / usable[usable.length - 1 - momentumLookback].close - 1);
  if (momentumPct < settings.minMomentumPct || momentumPct > settings.maxMomentumPct) return null;

  const emaFast = ema(closes.slice(-Math.min(12, closes.length)), 9);
  const emaSlow = ema(closes.slice(-Math.min(26, closes.length)), 21);
  if (current.close <= emaFast || emaFast <= emaSlow) return null;

  const volumeBars = usable.filter((bar) => bar.volume > 0);
  const totalVolume = volumeBars.reduce((sum, bar) => sum + bar.volume, 0);
  const vwap = totalVolume > 0
    ? volumeBars.reduce((sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume, 0) / totalVolume
    : current.close;
  if (current.close <= vwap) return null;

  const recentVolumes = usable.slice(-3).map((bar) => bar.volume).filter((value) => value > 0);
  const baselineVolumes = usable.slice(0, -3).map((bar) => bar.volume).filter((value) => value > 0);
  const baseline = baselineVolumes.length ? median(baselineVolumes) : 0;
  const recent = recentVolumes.length ? recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length : 0;
  const relativeVolume = baseline > 0 ? recent / baseline : 0;
  if (relativeVolume < settings.minRelativeVolume) return null;

  const priorHigh = Math.max(...usable.slice(-7, -1).map((bar) => bar.high));
  const breakoutPct = pct(current.close / priorHigh - 1);

  const trendStrength = Math.min(25, Math.max(0, pct(emaFast / emaSlow - 1) * 30));
  const momentumScore = Math.min(30, ((momentumPct - settings.minMomentumPct) / Math.max(0.01, settings.maxMomentumPct - settings.minMomentumPct)) * 30);
  const volumeScore = Math.min(25, Math.max(0, (relativeVolume - 1) * 20));
  const breakoutScore = Math.min(20, Math.max(0, (breakoutPct + 0.15) * 20));
  const score = Math.min(100, Math.round(25 + trendStrength + momentumScore + volumeScore + breakoutScore));
  if (score < settings.minScore) return null;

  const confidence = Math.min(0.92, 0.5 + score / 200);
  const expectedMovePct = Math.min(settings.takeProfitPct, Math.max(settings.minMomentumPct, momentumPct * 0.55));
  return {
    symbol,
    score,
    confidence,
    expectedMovePct,
    price: current.close,
    momentumPct,
    breakoutPct,
    relativeVolume,
    vwap,
    emaFast,
    emaSlow,
    reason: `${score}/100 momentum setup: ${momentumPct.toFixed(2)}% over 20m, ${relativeVolume.toFixed(2)}x volume, ${breakoutPct.toFixed(2)}% versus the recent high.`,
  };
}
