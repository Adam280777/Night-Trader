/**
 * Historical replay: a second way for the model to learn, alongside the live counterfactuals.
 *
 * Live learning yields about eight labelled nights a day. Yahoo's daily bars let us manufacture many
 * more: for every past session of a symbol we can rebuild exactly what the screener would have seen
 * that evening (using only bars up to that close, so there is no lookahead), keep the nights the
 * screener would have shortlisted, and label each by the real close-to-next-open move.
 *
 * Replayed nights have no headlines or market context, so those features are reported as frozen to
 * `train()` rather than fed in as neutral placeholders that would teach the model they never vary.
 */

import { breakEvenPct } from "./costs";
import { extractFeatures, type FeatureVector } from "./features";
import { computeSignals, scoreSignals } from "./screener";
import { trendOf, volOf } from "./regime";
import { sma } from "./stats";
import type { MarketContext } from "./schemas";
import type { TrainingSample } from "./model";
import type { QuantTuning } from "./tuning";
import type { Bar } from "../market/data";
import type { Market } from "../t212/instruments";

/** Features that need live headlines, company data or intraday market context that daily bars cannot supply. */
export const REPLAY_FROZEN_FEATURES: ReadonlySet<string> = new Set([
  "newsSentiment",
  "newsBurst",
  "binaryEvent",
  "earningsSoon",
  "marketBias",
  "breadth",
  "ukMarket",
  "analystTilt",
  "targetUpside",
  "analystRevisions",
  "shortInterest",
  "earningsSurprise",
  "volRegime",
  "vixShock",
  "trend",
]);

/** Market-regime features a replay can rebuild from index and VIX history, so they need not be frozen when that history is available. */
const SERIES_FEATURES = ["volRegime", "vixShock", "trend"];

export function replayFrozenFeatures(hasMarketSeries: boolean): ReadonlySet<string> {
  return hasMarketSeries ? new Set([...REPLAY_FROZEN_FEATURES].filter((k) => !SERIES_FEATURES.includes(k))) : REPLAY_FROZEN_FEATURES;
}

/**
 * What the market looked like at each past close, from index and VIX daily bars (oldest first), keyed
 * by session date. Uses only data up to that close, exactly as the live regime does.
 */
export function marketContextSeries(index: Bar[], vix: Bar[]): Map<string, MarketContext> {
  const vixByDay = new Map(vix.map((b) => [dayKey(b.date), b.close]));
  const out = new Map<string, MarketContext>();
  const closes: number[] = [];
  let prevVix: number | null = null;
  for (const b of index) {
    closes.push(b.close);
    const day = dayKey(b.date);
    const v = vixByDay.get(day) ?? null;
    const vixChange = v != null && prevVix != null && prevVix > 0 ? (v / prevVix - 1) * 100 : null;
    if (v != null) prevVix = v;
    if (closes.length < 50 || v == null || vixChange == null) continue;
    const s20 = sma(closes, 20);
    const s50 = sma(closes, 50);
    const trendRegime = trendOf((b.close / s20 - 1) * 100, (b.close / s50 - 1) * 100);
    out.set(day, {
      summary: "",
      riskEventsTonight: [],
      futuresBias: "unknown",
      sources: [],
      futuresGapPct: null,
      vix: v,
      vixChangePct: vixChange,
      breadth: null,
      trendRegime,
      volRegime: volOf(v),
    });
  }
  return out;
}

export interface ReplayRow {
  symbol: string;
  /** Session date (YYYY-MM-DD) whose close the trade would have been made at. */
  date: string;
  score: number;
  features: FeatureVector;
  label: boolean;
  gapPct: number;
}

export interface ReplayMeta {
  symbol: string;
  market: Market;
  currency?: string;
}

export interface ReplayOptions {
  /** Sessions to leave out at the end; live counterfactuals already cover those. */
  holdoutDays?: number;
  /** Bars of context required before the first replayed night. */
  minHistory?: number;
  /** Bars of context each night's signals are computed from. */
  window?: number;
  /** Market regime by session date. When given, nights without an entry are skipped rather than scored with a neutral placeholder. */
  marketContext?: Map<string, MarketContext>;
}

/** A move this large overnight is almost always a data error or corporate action, not a tradable edge. */
const MAX_ABS_GAP_PCT = 25;
/** Longest calendar gap between two consecutive sessions that is still an ordinary overnight (long weekends). */
const MAX_CALENDAR_GAP_DAYS = 5;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Every replayable night of one symbol, oldest first. `bars` must be oldest first. Signals for night
 * i use only bars[0..i]; the label uses bar i+1's open.
 */
export function replaySymbol(bars: Bar[], meta: ReplayMeta, tuning: QuantTuning, opts: ReplayOptions = {}): ReplayRow[] {
  const holdout = opts.holdoutDays ?? 10;
  const minHistory = opts.minHistory ?? 60;
  const window = opts.window ?? 260;
  const out: ReplayRow[] = [];

  const last = bars.length - 2 - holdout; // index of the last session with a next open to label against
  for (let i = Math.max(minHistory, 25); i <= last; i++) {
    const today = bars[i];
    const next = bars[i + 1];
    if (!(today.close > 0) || !(next.open > 0)) continue;
    if ((next.date.getTime() - today.date.getTime()) / 86_400_000 > MAX_CALENDAR_GAP_DAYS) continue;
    const gapPct = (next.open / today.close - 1) * 100;
    if (Math.abs(gapPct) > MAX_ABS_GAP_PCT) continue;

    const hist = bars.slice(Math.max(0, i - window + 1), i + 1);
    const base = hist.slice(-61, -1);
    const avgVolume = base.length ? base.reduce((s, b) => s + b.volume, 0) / base.length : 0;
    if (!(avgVolume > 0) || !(today.volume > 0)) continue;

    const context = opts.marketContext ? (opts.marketContext.get(dayKey(today.date)) ?? null) : null;
    if (opts.marketContext && !context) continue;

    const sig = computeSignals(hist, { price: today.close, volume: today.volume, avgVolume3m: avgVolume, currency: meta.currency }, next.date.getUTCDay());
    if (!sig) continue;

    const signals = { ...sig, earningsWithin2d: false };
    const features = extractFeatures({ market: meta.market, signals, research: null, context });
    const bar = breakEvenPct(meta.market, { atrPct: sig.atrPct, dollarVolume: sig.dollarVolume }, tuning);
    out.push({ symbol: meta.symbol, date: dayKey(today.date), score: scoreSignals(sig), features, label: gapPct > bar, gapPct });
  }
  return out;
}

/**
 * Keep only the nights the screener would have shortlisted: the top `fraction` by score among the
 * symbols replayed on each date. Training on every night of every name would teach the model about a
 * population it never actually chooses from.
 */
export function selectShortlisted(rows: ReplayRow[], fraction: number, minPerDate = 1): ReplayRow[] {
  const byDate = new Map<string, ReplayRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date);
    if (list) list.push(r);
    else byDate.set(r.date, [r]);
  }
  const kept: ReplayRow[] = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b.score - a.score);
    const n = Math.max(minPerDate, Math.ceil(list.length * fraction));
    kept.push(...list.slice(0, n));
  }
  return kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.score - a.score));
}

export function toTrainingSamples(rows: ReplayRow[], weight: number): TrainingSample[] {
  return rows.map((r) => ({ features: r.features, label: r.label, weight }));
}

export interface BackfillStats {
  symbols: number;
  nights: number;
  /** Mean squared error of the model on nights it had not yet trained on (progressive validation). */
  brierSum: number;
  /** Same measure for always predicting the base rate of that batch. */
  baselineBrierSum: number;
  updatedAt: number;
}

export const BACKFILL_STATS_KEY = "backfill:stats";
