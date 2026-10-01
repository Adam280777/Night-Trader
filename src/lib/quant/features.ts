/**
 * The feature vocabulary. One place defines each feature's extraction, its human label, its display
 * format and its prior coefficient, so scoring, learning, explanation and lesson mining can never
 * drift apart.
 *
 * Features are pre-scaled into roughly comparable ranges here; the model additionally standardises
 * them online. Prior coefficients are in log-odds per unit and encode well-documented overnight
 * effects (the overnight drift anomaly, intraday-to-overnight reversal, event risk, the volatility
 * regime) so the engine behaves sensibly from day one and learns away from the prior with evidence.
 */

import { clamp, finite } from "./stats";
import type { Signals } from "./screener";
import type { MarketContext, Research } from "./schemas";

export interface FeatureContext {
  market: "US" | "UK";
  signals: Signals;
  research: Research | null;
  context: MarketContext | null;
}

export interface FeatureDef {
  key: string;
  label: string;
  /** Prior coefficient in log-odds per unit of the (pre-scaled) feature. */
  prior: number;
  extract: (c: FeatureContext) => number;
  /** Renders the raw driver for a human, e.g. "closed at 92% of the day's range". */
  display: (c: FeatureContext) => string;
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

/** Market-wide overnight bias: the lead market's move for UK, the futures basis for US. */
const marketBias = (c: FeatureContext) => clamp(finite(c.context?.futuresGapPct ?? 0), -2.5, 2.5);

export const FEATURES: FeatureDef[] = [
  {
    key: "gapSharpe",
    label: "Historical overnight drift",
    prior: 1.2,
    extract: (c) => clamp(c.signals.gapSharpe, -0.5, 0.5),
    display: (c) => `mean overnight gap ${pct(c.signals.gapMeanPct)} with ${c.signals.gapStdPct.toFixed(2)}% dispersion`,
  },
  {
    key: "gapTStat",
    label: "Reliability of that drift",
    prior: 0.5,
    extract: (c) => clamp(c.signals.gapTStat / 3, -1, 1),
    display: (c) => `t-stat ${c.signals.gapTStat.toFixed(2)} over the gap sample`,
  },
  {
    key: "gapHitRate",
    label: "Share of positive nights",
    prior: 0.4,
    extract: (c) => clamp((c.signals.gapHitRate - 0.5) * 2, -1, 1),
    display: (c) => `${(c.signals.gapHitRate * 100).toFixed(0)}% of recent nights were positive`,
  },
  {
    key: "gapRecent",
    label: "Recent overnight behaviour",
    prior: 0.25,
    extract: (c) => clamp(c.signals.gapRecentPct, -1.5, 1.5),
    display: (c) => `last 20 nights averaged ${pct(c.signals.gapRecentPct)}`,
  },
  {
    key: "gapWeekday",
    label: "Weekday overnight pattern",
    prior: 0.2,
    extract: (c) => clamp(c.signals.gapWeekdayPct, -1.5, 1.5),
    display: (c) => `this weekday averaged ${pct(c.signals.gapWeekdayPct)} overnight`,
  },
  {
    key: "gapLast",
    label: "This morning's gap",
    prior: 0,
    extract: (c) => clamp(c.signals.gapLastPct ?? 0, -5, 5),
    display: (c) => `opened ${pct(c.signals.gapLastPct ?? 0)} versus yesterday's close`,
  },
  {
    key: "gapTail",
    label: "Frequency of bad gaps",
    prior: -0.3,
    extract: (c) => clamp((c.signals.gapTailRate ?? 0) * 10, 0, 3),
    display: (c) => `${Math.round((c.signals.gapTailRate ?? 0) * 100)}% of recent nights opened more than 2% lower`,
  },
  {
    key: "overnightShare",
    label: "Return earned overnight",
    prior: 0.4,
    extract: (c) => clamp(c.signals.overnightShare, -1, 1),
    display: (c) => `${Math.round(c.signals.overnightShare * 100)}% of this name's move accrues overnight rather than intraday`,
  },
  {
    key: "closeLocation",
    label: "Close within the day's range",
    prior: 0.35,
    extract: (c) => clamp((c.signals.closeLocation - 0.5) * 2, -1, 1),
    display: (c) => `closed at ${(c.signals.closeLocation * 100).toFixed(0)}% of the day's range`,
  },
  {
    key: "intradayReversal",
    label: "Today's move (reversal risk)",
    prior: -0.18,
    extract: (c) => clamp(c.signals.ret1dPct / Math.max(1, c.signals.atrPct), -3, 3),
    display: (c) => `up ${pct(c.signals.ret1dPct)} today, ${(c.signals.ret1dPct / Math.max(1, c.signals.atrPct)).toFixed(1)}x its average range`,
  },
  {
    key: "momentum5d",
    label: "5-day momentum",
    prior: 0.12,
    extract: (c) => clamp(c.signals.ret5dPct / 5, -2, 2),
    display: (c) => `${pct(c.signals.ret5dPct)} over 5 days`,
  },
  {
    key: "momentum20d",
    label: "20-day trend",
    prior: 0.06,
    extract: (c) => clamp(c.signals.ret20dPct / 10, -2, 2),
    display: (c) => `${pct(c.signals.ret20dPct)} over 20 days`,
  },
  {
    key: "relVolume",
    label: "Relative volume",
    prior: 0.15,
    extract: (c) => Math.log(clamp(c.signals.relVolume, 0.25, 4)),
    display: (c) => `${c.signals.relVolume.toFixed(1)}x normal volume`,
  },
  {
    key: "volumeTrend",
    label: "Volume trend",
    prior: 0.08,
    extract: (c) => Math.log(clamp(c.signals.volumeTrend, 0.4, 3)),
    display: (c) => `5-day volume ${c.signals.volumeTrend.toFixed(1)}x its 3-month base`,
  },
  {
    key: "volatility",
    label: "Single-name volatility",
    prior: -0.18,
    extract: (c) => clamp(c.signals.atrPct / 2, 0, 3),
    display: (c) => `${c.signals.atrPct.toFixed(1)}% average true range`,
  },
  {
    key: "stretch",
    label: "Stretch above the 20-day average",
    prior: -0.08,
    extract: (c) => clamp(c.signals.vsSma20Pct / 10, -2, 2),
    display: (c) => `${pct(c.signals.vsSma20Pct)} versus its 20-day average`,
  },
  {
    key: "rsi",
    label: "RSI",
    prior: -0.06,
    extract: (c) => clamp((c.signals.rsi14 - 50) / 25, -2, 2),
    display: (c) => `RSI ${c.signals.rsi14.toFixed(0)}`,
  },
  {
    key: "from52wHigh",
    label: "Distance from the 52-week high",
    prior: 0.08,
    extract: (c) => clamp(c.signals.from52wHighPct / 10, -3, 0),
    display: (c) => `${pct(c.signals.from52wHighPct)} from its 52-week high`,
  },
  {
    key: "newsSentiment",
    label: "Headline sentiment",
    prior: 0.45,
    extract: (c) => clamp(c.research?.sentiment ?? 0, -1, 1),
    display: (c) => `headline sentiment ${(c.research?.sentiment ?? 0).toFixed(2)} across ${c.research?.headlines.length ?? 0} recent stories`,
  },
  {
    key: "analystTilt",
    label: "Analyst consensus",
    prior: 0.08,
    // 1 = strong buy, 3 = hold, 5 = sell; centred so a hold reads zero.
    extract: (c) => (c.research?.fundamentals?.analystMean == null ? 0 : clamp((3 - c.research.fundamentals.analystMean) / 2, -1, 1)),
    display: (c) => {
      const f = c.research?.fundamentals;
      return f?.analystMean == null ? "no analyst consensus available" : `analyst consensus ${f.analystMean.toFixed(1)} of 5 (1 is strong buy) from ${f.analystCount ?? "?"} analysts`;
    },
  },
  {
    key: "targetUpside",
    label: "Distance to analyst target",
    prior: 0.05,
    extract: (c) => (c.research?.fundamentals?.targetUpsidePct == null ? 0 : clamp(c.research.fundamentals.targetUpsidePct / 30, -1.5, 1.5)),
    display: (c) => {
      const f = c.research?.fundamentals;
      return f?.targetUpsidePct == null ? "no analyst price target available" : `the mean analyst target is ${pct(f.targetUpsidePct)} from the price`;
    },
  },
  {
    key: "analystRevisions",
    label: "Recent rating changes",
    prior: 0.2,
    extract: (c) => clamp(c.research?.fundamentals?.netUpgrades14d ?? 0, -3, 3),
    display: (c) => {
      const n = c.research?.fundamentals?.netUpgrades14d;
      return n == null ? "no rating-change data" : `${n >= 0 ? "+" : ""}${n} net analyst upgrades over 14 days`;
    },
  },
  {
    key: "shortInterest",
    label: "Short interest",
    prior: -0.1,
    extract: (c) => clamp((c.research?.fundamentals?.shortPctFloat ?? 0) * 10, 0, 3),
    display: (c) => {
      const s = c.research?.fundamentals?.shortPctFloat;
      return s == null ? "short interest unknown" : `${(s * 100).toFixed(1)}% of the float is sold short`;
    },
  },
  {
    key: "earningsSurprise",
    label: "Earnings track record",
    prior: 0.1,
    extract: (c) => clamp((c.research?.fundamentals?.epsSurprisePct ?? 0) / 10, -2, 2),
    display: (c) => {
      const e = c.research?.fundamentals?.epsSurprisePct;
      return e == null ? "no earnings history" : `earnings have beaten estimates by ${pct(e)} on average over four reports`;
    },
  },
  {
    key: "newsBurst",
    label: "News flow intensity",
    prior: 0.05,
    extract: (c) => clamp(Math.log(clamp(c.research?.newsBurst ?? 1, 0.2, 8)), -1.6, 2.1),
    display: (c) => `news flow ${(c.research?.newsBurst ?? 1).toFixed(1)}x normal`,
  },
  {
    key: "binaryEvent",
    label: "Unresolved binary event",
    prior: -0.8,
    extract: (c) => (c.research?.earningsOrBinaryEventBeforeNextOpen ? 1 : 0),
    display: (c) => (c.research?.earningsOrBinaryEventBeforeNextOpen ? "a binary event lands before the next open" : "no binary event before the next open"),
  },
  {
    key: "earningsSoon",
    label: "Earnings within two days",
    prior: -0.7,
    extract: (c) => (c.signals.earningsWithin2d ? 1 : 0),
    display: (c) => (c.signals.earningsWithin2d ? "earnings are due within two days" : "no earnings due within two days"),
  },
  {
    key: "marketBias",
    label: "Market-wide overnight bias",
    prior: 0.35,
    extract: marketBias,
    display: (c) =>
      c.context?.futuresGapPct == null
        ? "no market-wide bias available"
        : `${c.market === "UK" ? "the lead US session" : "index futures"} imply ${pct(c.context.futuresGapPct)}`,
  },
  {
    key: "volRegime",
    label: "Volatility regime",
    prior: -0.2,
    extract: (c) => clamp(((c.context?.vix ?? 18) - 18) / 10, -1, 2.5),
    display: (c) => (c.context?.vix == null ? "volatility regime unknown" : `VIX ${c.context.vix.toFixed(1)} (${c.context.volRegime})`),
  },
  {
    key: "vixShock",
    label: "Volatility spike today",
    prior: -0.15,
    extract: (c) => clamp((c.context?.vixChangePct ?? 0) / 10, -2, 3),
    display: (c) => `VIX ${pct(c.context?.vixChangePct ?? 0)} today`,
  },
  {
    key: "breadth",
    label: "Market breadth",
    prior: 0.2,
    extract: (c) => clamp(((c.context?.breadth ?? 0.5) - 0.5) * 2, -1, 1),
    display: (c) => (c.context?.breadth == null ? "breadth unknown" : `${Math.round(c.context.breadth * 100)}% of sectors green`),
  },
  {
    key: "trend",
    label: "Index trend",
    prior: 0.15,
    extract: (c) => (c.context?.trendRegime === "bull" ? 1 : c.context?.trendRegime === "bear" ? -1 : 0),
    display: (c) => `${c.context?.trendRegime ?? "unknown"} index trend`,
  },
  {
    key: "ukMarket",
    label: "UK market",
    prior: -0.2,
    extract: (c) => (c.market === "UK" ? 1 : 0),
    display: (c) => (c.market === "UK" ? "UK listing (0.5% stamp duty on the buy)" : "US listing"),
  },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);
export const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Base rate: the unconditional chance a shortlisted name clears costs overnight. */
export const PRIOR_BIAS = -0.55;

export type FeatureVector = Record<string, number>;

export function extractFeatures(c: FeatureContext): FeatureVector {
  const out: FeatureVector = {};
  for (const f of FEATURES) out[f.key] = finite(f.extract(c));
  return out;
}

export function describeFeature(key: string, c: FeatureContext): string {
  return FEATURE_BY_KEY.get(key)?.display(c) ?? key;
}

export const priorWeights = (): FeatureVector => Object.fromEntries(FEATURES.map((f) => [f.key, f.prior]));
