import { describe, expect, it } from "vitest";
import { binomialPValue, logit, normalCdf, normalMeanAbove, normalMeanBelow, rsi, shrunkRate, sigmoid, std } from "./stats";
import { classifyHeadline, scoreHeadline } from "./news";
import { breakEvenPct, roundTripCostPct } from "./costs";
import { computeSignals, majorUnitPrice, overnightGaps, type Signals } from "./screener";
import { findAnalogues, unconditionalAnalogue } from "./analogues";
import { freshModel, predict, train, applyCalibration } from "./model";
import { matchesRule, applyRules } from "./rules";
import { assessPromotionReadiness, liveOutcomeWeight, mineLessons, type LabelledRow } from "./learn";
import { summariseDailyAttribution } from "./memory";
import { decide, type CandidateInput, type DecideInput } from "./decide";
import { extractFeatures, priorWeights } from "./features";
import { DEFAULT_TUNING, QuantTuningSchema, TUNING_GROUPS, TUNING_PARAMS, TUNING_PRESETS } from "./tuning";
import { accuracyOf, auc } from "./accuracy";
import { REPLAY_FROZEN_FEATURES, marketContextSeries, replayFrozenFeatures, replaySymbol, selectShortlisted, toTrainingSamples, type ReplayRow } from "./backfill";
import { ResearchSchema } from "./schemas";
import { chronologicalEvaluation, strategyRisk } from "./evaluation";
import type { Bar } from "../market/data";

describe("stats", () => {
  it("normalCdf matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  describe("strategy evaluation", () => {
    it("computes compounded return, drawdown and profit factor in sequence", () => {
      const report = strategyRisk([10, -10, 5])!;
      expect(report.compoundedReturnPct).toBeCloseTo(3.95, 6);
      expect(report.maxDrawdownPct).toBeCloseTo(10, 6);
      expect(report.profitFactor).toBeCloseTo(1.5, 6);
      expect(report.worstPct).toBe(-10);
    });

    it("keeps chronological and market slices separate", () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        id: 20 - index,
        market: (index % 2 ? "US" : "UK") as "US" | "UK",
        probability: index < 10 ? 0.8 : 0.2,
        screenScore: index,
        label: index < 10,
      }));
      const report = chronologicalEvaluation(rows)!;
      expect(report.slices.map((slice) => slice.label)).toEqual(["All live predictions", "Earlier half", "Recent half", "US", "UK", "calm volatility", "normal volatility", "stressed volatility", "unknown volatility"]);
      expect(report.slices[1].n).toBe(10);
      expect(report.slices[2].n).toBe(10);
    });
  });

  it("conditional means straddle the threshold", () => {
    const above = normalMeanAbove(0, 1, 0);
    const below = normalMeanBelow(0, 1, 0);
    expect(above).toBeGreaterThan(0);
    expect(below).toBeLessThan(0);
    // For a symmetric normal the two halves must cancel.
    expect((above + below) / 2).toBeCloseTo(0, 6);
  });

  it("sigmoid and logit invert each other", () => {
    for (const p of [0.05, 0.3, 0.5, 0.8, 0.97]) expect(sigmoid(logit(p))).toBeCloseTo(p, 8);
  });

  it("shrunkRate pulls small samples toward the prior", () => {
    expect(shrunkRate(1, 1, 0.5, 8)).toBeLessThan(0.7);
    // A large sample should dominate the prior.
    expect(shrunkRate(900, 1000, 0.5, 8)).toBeGreaterThan(0.88);
  });

  it("binomialPValue is small only for lopsided samples", () => {
    expect(binomialPValue(50, 100, 0.5)).toBeGreaterThan(0.5);
    expect(binomialPValue(80, 100, 0.5)).toBeLessThan(0.01);
  });

  it("rsi is high after a straight run up", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBeGreaterThan(90);
  });

  it("std of a constant series is zero", () => {
    expect(std([3, 3, 3, 3])).toBe(0);
  });
});

describe("news", () => {
  it("scores clearly good and bad headlines with the right sign", () => {
    expect(scoreHeadline("Acme beats earnings estimates and raises guidance")).toBeGreaterThan(0);
    expect(scoreHeadline("Acme misses estimates, cuts guidance and warns on demand")).toBeLessThan(0);
  });

  it("handles negation", () => {
    const plain = scoreHeadline("Acme beats estimates");
    const negated = scoreHeadline("Acme does not beat estimates");
    expect(negated).toBeLessThan(plain);
  });

  it("returns a neutral score for headlines with no loaded words", () => {
    expect(scoreHeadline("Acme Corporation to present at a conference")).toBe(0);
  });

  it("classifies event types", () => {
    const tags = (t: string) => classifyHeadline(t).map((e) => (typeof e === "string" ? e : e.tag));
    expect(tags("Acme Q3 earnings call scheduled")).toContain("earnings");
    expect(tags("Analyst upgrades Acme to buy, raises price target")).toContain("rating");
    expect(tags("Acme to acquire Beta Corp in $2bn deal")).toContain("mna");
  });
});

/** Synthetic bars with a controllable overnight drift, so expectations are exact. */
function makeBars(n: number, gapPct: (i: number) => number): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close * (1 + gapPct(i) / 100);
    const high = Math.max(open, close) * 1.01;
    const low = Math.min(open, close) * 0.99;
    const nextClose = open * 1.001;
    bars.push({
      date: new Date(Date.UTC(2022, 0, 3 + i)),
      open,
      high: Math.max(high, nextClose),
      low: Math.min(low, nextClose),
      close: nextClose,
      volume: 5_000_000,
    });
    close = nextClose;
  }
  return bars;
}

describe("screener signals", () => {
  it("recovers a known overnight drift", () => {
    const bars = makeBars(120, () => 0.5);
    const gaps = overnightGaps(bars);
    expect(gaps.length).toBe(119);
    for (const g of gaps) expect(g.pct).toBeCloseTo(0.5, 6);
  });

  it("computeSignals reports a positive mean gap and full hit rate", () => {
    const bars = makeBars(140, () => 0.4);
    const s = computeSignals(bars, { price: bars.at(-1)!.close, currency: "USD" } as never, 2);
    expect(s).not.toBeNull();
    expect(s!.gapMeanPct).toBeGreaterThan(0.3);
    expect(s!.gapHitRate).toBeCloseTo(1, 2);
  });

  it("measures UK turnover in pounds, not pence", () => {
    const bars = makeBars(140, () => 0.4);
    const q = { price: 2500, volume: 1_000_000, avgVolume3m: 1_000_000 };
    const uk = computeSignals(bars, { ...q, currency: "GBp" }, 2)!;
    const us = computeSignals(bars, { ...q, price: 25, currency: "USD" }, 2)!;
    expect(uk.dollarVolume).toBeCloseTo(us.dollarVolume, 6);
    expect(majorUnitPrice(2500, "GBX")).toBe(25);
    expect(majorUnitPrice(25, "GBP")).toBe(25);
  });

  it("reports this morning's gap and how often the name opens badly", () => {
    const bars = makeBars(130, (i) => (i === 129 ? 3 : i % 10 === 0 ? -4 : 0.1));
    const sig = computeSignals(bars, { price: 100, volume: 5e6, avgVolume3m: 5e6, currency: "USD" }, 2)!;
    expect(sig.gapLastPct).toBeCloseTo(3, 6);
    expect(sig.gapTailRate).toBeGreaterThan(0.05);
    expect(sig.gapTailRate).toBeLessThan(0.15);
  });

  it("returns null without enough history", () => {
    expect(computeSignals(makeBars(5, () => 0.1), { price: 100, currency: "USD" } as never, 2)).toBeNull();
  });
});

describe("fundamentals features", () => {
  const sig = {
    ret1dPct: 0, ret5dPct: 0, ret20dPct: 0, gapMeanPct: 0, gapStdPct: 1, gapHitRate: 0.5, gapSharpe: 0, gapTStat: 0, gapLastPct: 0, gapTailRate: 0,
    gapRecentPct: 0, gapWeekdayPct: 0, overnightShare: 0, atrPct: 2, realizedVolPct: 20, closeLocation: 0.5, intradayRangePct: 2, relVolume: 1,
    volumeTrend: 1, dollarVolume: 5e7, rsi14: 50, vsSma20Pct: 0, vsSma50Pct: 0, from52wHighPct: 0, earningsWithin2d: false,
  } as Signals;
  const research = (f: unknown) => ResearchSchema.parse({ ticker: "X", summary: "", catalysts: [], risks: [], sentiment: 0, overnightRisk: "low", earningsOrBinaryEventBeforeNextOpen: false, sources: [], fundamentals: f });

  it("turns analyst data into signed features and stays neutral without it", () => {
    const bullish = extractFeatures({ market: "US", signals: sig, context: null, research: research({ analystMean: 1.5, targetUpsidePct: 30, shortPctFloat: 0.2, epsSurprisePct: 10, netUpgrades14d: 2 }) });
    expect(bullish.analystTilt).toBeCloseTo(0.75, 6);
    expect(bullish.targetUpside).toBeCloseTo(1, 6);
    expect(bullish.analystRevisions).toBe(2);
    expect(bullish.shortInterest).toBeCloseTo(2, 6);
    expect(bullish.earningsSurprise).toBeCloseTo(1, 6);

    const none = extractFeatures({ market: "US", signals: sig, context: null, research: research(null) });
    for (const k of ["analystTilt", "targetUpside", "analystRevisions", "shortInterest", "earningsSurprise"]) expect(none[k]).toBe(0);
    for (const k of ["gapLast", "gapTail"]) expect(Number.isFinite(extractFeatures({ market: "US", signals: sig, context: null, research: null })[k])).toBe(true);
  });

  it("reads research stored before fundamentals existed", () => {
    const old = ResearchSchema.parse({ ticker: "X", summary: "", catalysts: [], risks: [], sentiment: 0, overnightRisk: "low", earningsOrBinaryEventBeforeNextOpen: false, sources: [] });
    expect(old.fundamentals).toBeNull();
  });
});

describe("costs", () => {
  const sig = { atrPct: 1.5, dollarVolume: 50_000_000 };
  it("charges stamp duty on UK stocks and not on US ones", () => {
    const uk = roundTripCostPct("UK", sig);
    expect(uk).toBeGreaterThan(DEFAULT_TUNING.ukStampDutyPct);
    expect(uk).toBeGreaterThan(roundTripCostPct("US", sig));
  });

  it("adds opening-auction slippage on top of the round trip", () => {
    expect(breakEvenPct("US", sig) - roundTripCostPct("US", sig)).toBeCloseTo(DEFAULT_TUNING.openingAuctionSlippagePct, 6);
  });
});

describe("analogues", () => {
  const repeat = (vals: number[], times: number) => Array.from({ length: times }, () => vals).flat();

  it("unconditionalAnalogue needs a minimum sample", () => {
    expect(unconditionalAnalogue([1, -1, 2])).toBeNull();
  });

  it("unconditionalAnalogue measures the probability of clearing a threshold", () => {
    const a = unconditionalAnalogue(repeat([1, 1, 1, 1, -1, -1, -1, -1, 2, 2, 2, 2], 3))!;
    expect(a).not.toBeNull();
    expect(a.samples).toBe(36);
    expect(a.probAbove(0)).toBeCloseTo(8 / 12, 2);
    expect(a.probAbove(5)).toBeLessThan(0.1);
  });

  it("conditional means split the distribution around the threshold", () => {
    const a = unconditionalAnalogue(repeat([-2, -1, 1, 2, 3, 4, -3, 1, 2, -1, 5, 0.5], 3))!;
    const { win, loss } = a.conditionalMeans(0);
    expect(win).toBeGreaterThan(0);
    expect(loss).toBeLessThan(0);
  });

  it("findAnalogues needs a long history", () => {
    expect(findAnalogues(makeBars(20, () => 0.2))).toBeNull();
    expect(findAnalogues(makeBars(400, (i) => (i % 3 === 0 ? 1.2 : -0.4)))).not.toBeNull();
  });
});

describe("model", () => {
  const featureVec = (overrides: Record<string, number> = {}) => ({ ...Object.fromEntries(Object.keys(priorWeights()).map((k) => [k, 0])), ...overrides });

  it("a fresh model starts at its priors", () => {
    const m = freshModel();
    const p = predict(m, featureVec());
    expect(p.probability).toBeGreaterThan(0);
    expect(p.probability).toBeLessThan(1);
    expect(m.samples).toBe(0);
  });

  it("training moves the probability toward observed labels", () => {
    const m = freshModel();
    const x = featureVec({ gapSharpe: 2 });
    const before = predict(m, x).probability;
    const trained = train(
      m,
      Array.from({ length: 200 }, () => ({ features: x, label: true })),
    );
    const after = predict(trained, x).probability;
    expect(after).toBeGreaterThan(before);
    expect(trained.samples).toBe(200);
  });

  it("training on negatives pushes the other way", () => {
    const x = featureVec({ gapSharpe: 2 });
    const up = train(freshModel(), Array.from({ length: 200 }, () => ({ features: x, label: true })));
    const down = train(freshModel(), Array.from({ length: 200 }, () => ({ features: x, label: false })));
    expect(predict(up, x).probability).toBeGreaterThan(predict(down, x).probability);
  });

  it("calibration is a no-op until there is evidence", () => {
    const m = freshModel();
    expect(applyCalibration(m, 0.42)).toBeCloseTo(0.42, 6);
  });

  it("contributions are reported per feature", () => {
    const p = predict(freshModel(), featureVec({ gapSharpe: 1.5 }));
    expect(Object.keys(p.contributions).length).toBeGreaterThan(0);
  });
});

describe("rules", () => {
  const rule = { feature: "gapSharpe", market: "US" as const, min: 0.5, max: null, adjustment: 0.4, samples: 40, winRate: 0.7, avgReturnPct: 0.8, pValue: 0.01 };

  it("matches only inside its band and market", () => {
    expect(matchesRule(rule, "US", { gapSharpe: 1 })).toBe(true);
    expect(matchesRule(rule, "US", { gapSharpe: 0.1 })).toBe(false);
    expect(matchesRule(rule, "UK", { gapSharpe: 1 })).toBe(false);
  });

  it("sums adjustments and clamps them", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i, text: `rule ${i}`, rule }));
    const eff = applyRules(many, "US", { gapSharpe: 1 });
    expect(Math.abs(eff.adjustment)).toBeLessThanOrEqual(1.2);
    expect(eff.applied.length).toBe(12);
  });
});

describe("lesson mining", () => {
  const row = (gapSharpe: number, label: boolean, market: "US" | "UK" = "US", id = 0): LabelledRow => ({
    id,
    tradingDate: "2026-01-01",
    ticker: "ACME_US_EQ",
    market,
    label,
    returnPct: label ? 1 : -1,
    costPct: 0.3,
    features: { gapSharpe },
  });

  it("mines nothing from a small sample", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, i % 2 === 0, "US", i));
    expect(mineLessons(rows)).toHaveLength(0);
  });

  it("mines nothing when the outcome is independent of the feature", () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i % 30, i % 2 === 0, "US", i));
    expect(mineLessons(rows)).toHaveLength(0);
  });

  it("finds a strong, significant pattern and keeps the adjustment bounded", () => {
    // High gapSharpe clears costs nine times out of ten, low gapSharpe only one time in ten.
    const rows: LabelledRow[] = [];
    for (let i = 0; i < 150; i++) rows.push(row(3 + (i % 5) * 0.1, i % 10 !== 0, "US", i));
    for (let i = 0; i < 150; i++) rows.push(row(-3 + (i % 5) * 0.1, i % 10 === 0, "US", 1000 + i));
    const mined = mineLessons(rows);
    expect(mined.length).toBeGreaterThan(0);
    expect(mined.every((m) => Math.abs(m.rule.adjustment) <= 0.7)).toBe(true);
    expect(mined.every((m) => m.rule.samples >= 30 && m.rule.pValue <= 0.05)).toBe(true);
    expect(mined.length).toBeLessThanOrEqual(12);
  });
});

describe("decide", () => {
  const signals: Signals = {
    ret1dPct: 1,
    ret5dPct: 3,
    ret20dPct: 5,
    gapMeanPct: 0.4,
    gapStdPct: 1.2,
    gapHitRate: 0.6,
    gapSharpe: 0.3,
    gapTStat: 2.5,
    gapLastPct: 0.2,
    gapTailRate: 0.05,
    gapRecentPct: 0.4,
    gapWeekdayPct: 0.3,
    overnightShare: 0.6,
    atrPct: 2,
    realizedVolPct: 25,
    closeLocation: 0.85,
    intradayRangePct: 2,
    relVolume: 1.6,
    volumeTrend: 0.2,
    dollarVolume: 80_000_000,
    rsi14: 60,
    vsSma20Pct: 3,
    vsSma50Pct: 6,
    from52wHighPct: -4,
    earningsWithin2d: false,
  };

  const candidate = (over: Partial<Signals> = {}, ticker = "AAPL_US_EQ"): CandidateInput => ({
    candidate: {
      ticker,
      name: "Acme",
      yahoo: "ACME",
      market: "US",
      type: "STOCK",
      currency: "USD",
      price: 100,
      signals: { ...signals, ...over },
      score: 1,
    },
    research: null,
    analogue: null,
  });

  const base = (over: Partial<DecideInput> = {}): DecideInput => ({
    market: "US",
    candidates: [candidate()],
    context: null,
    model: freshModel(),
    rules: [],
    account: { totalValue: 10_000, availableCash: 5_000, currency: "GBP" },
    minutesToClose: 8,
    minConfidence: 0.6,
    minEdgePct: 0.3,
    ...over,
  });

  it("evaluates every candidate and always returns a decision", () => {
    const out = decide(base({ candidates: [candidate(), candidate({}, "MSFT_US_EQ")] }));
    expect(out.evaluated).toHaveLength(2);
    expect(out.decision.evaluations).toHaveLength(2);
    expect(["BUY", "NO_TRADE"]).toContain(out.decision.action);
  });

  it("refuses to trade when there are no candidates", () => {
    const out = decide(base({ candidates: [] }));
    expect(out.decision.action).toBe("NO_TRADE");
    expect(out.chosen).toBeNull();
  });

  it("vetoes earnings inside the window", () => {
    const out = decide(base({ candidates: [candidate({ earningsWithin2d: true })] }));
    expect(out.decision.action).toBe("NO_TRADE");
    expect(out.decision.thesis).toMatch(/earnings/i);
  });

  it("vetoes illiquid names", () => {
    const out = decide(base({ candidates: [candidate({ dollarVolume: 500_000 })] }));
    expect(out.decision.action).toBe("NO_TRADE");
  });

  it("refuses when the confidence bar is impossible", () => {
    const out = decide(base({ minConfidence: 0.99 }));
    expect(out.decision.action).toBe("NO_TRADE");
  });

  it("refuses when the edge bar is impossible", () => {
    const out = decide(base({ minConfidence: 0, minEdgePct: 50 }));
    expect(out.decision.action).toBe("NO_TRADE");
  });

  it("a NO_TRADE still explains the rejected names", () => {
    const out = decide(base({ minConfidence: 0.99, candidates: [candidate(), candidate({}, "MSFT_US_EQ")] }));
    expect(out.decision.whyNotOthers.length).toBeGreaterThan(0);
    expect(out.decision.investPct).toBe(0);
  });

  it("never sizes above the account", () => {
    const out = decide(base({ minConfidence: 0, minEdgePct: -100 }));
    expect(out.decision.investPct).toBeGreaterThanOrEqual(0);
    expect(out.decision.investPct).toBeLessThanOrEqual(1);
  });

  it("a stressed volatility regime vetoes everything", () => {
    const out = decide(
      base({
        minConfidence: 0,
        minEdgePct: -100,
        context: { volRegime: "stressed" } as never,
      }),
    );
    expect(out.decision.action).toBe("NO_TRADE");
  });

  it("tuning can switch a veto off", () => {
    const ctx = { volRegime: "stressed" } as never;
    const off = decide(
      base({
        minConfidence: 0,
        minEdgePct: -100,
        context: ctx,
        tuning: { ...DEFAULT_TUNING, vetoStressedVol: false },
      }),
    );
    expect(off.evaluated[0].evaluation.vetoes).not.toContain("volatility regime is stressed");
  });

  it("the earnings veto is tunable", () => {
    const out = decide(
      base({
        candidates: [candidate({ earningsWithin2d: true })],
        minConfidence: 0,
        minEdgePct: -100,
        tuning: { ...DEFAULT_TUNING, vetoEarnings: false },
      }),
    );
    expect(out.evaluated[0].evaluation.vetoes).not.toContain("earnings within two days");
  });

  it("a larger Kelly fraction sizes larger for the same edge", () => {
    // The base candidate's edge is negative, which clamps Kelly to zero; a wide, strongly positive
    // setup keeps the result off both the 0 and 1 clamps so the proportionality is observable.
    const strong = [candidate({ gapMeanPct: 5, gapStdPct: 8, gapHitRate: 0.9, gapSharpe: 2, gapTStat: 6 })];
    const small = decide(base({ candidates: strong, minConfidence: 0, minEdgePct: -100, tuning: { ...DEFAULT_TUNING, kellyFraction: 0.1 } }));
    const large = decide(base({ candidates: strong, minConfidence: 0, minEdgePct: -100, tuning: { ...DEFAULT_TUNING, kellyFraction: 0.5 } }));
    expect(small.evaluated[0].evaluation.kellyFraction).toBeGreaterThan(0);
    expect(large.evaluated[0].evaluation.kellyFraction).toBeGreaterThan(small.evaluated[0].evaluation.kellyFraction);
  });

  it("a bigger uncertainty charge lowers the risk-adjusted edge", () => {
    const lenient = decide(base({ minConfidence: 0, minEdgePct: -100, tuning: { ...DEFAULT_TUNING, uncertaintyPenalty: 0 } }));
    const strict = decide(base({ minConfidence: 0, minEdgePct: -100, tuning: { ...DEFAULT_TUNING, uncertaintyPenalty: 3 } }));
    expect(strict.evaluated[0].evaluation.riskAdjustedEdgePct).toBeLessThan(lenient.evaluated[0].evaluation.riskAdjustedEdgePct);
  });

  it("a higher cost buffer raises the hurdle and shrinks the edge", () => {
    const cheap = decide(base({ minConfidence: 0, minEdgePct: -100 }));
    const pricey = decide(base({ minConfidence: 0, minEdgePct: -100, tuning: { ...DEFAULT_TUNING, extraCostBufferPct: 1 } }));
    expect(pricey.evaluated[0].evaluation.costPct).toBeGreaterThan(cheap.evaluated[0].evaluation.costPct);
    expect(pricey.evaluated[0].evaluation.edgePct).toBeLessThan(cheap.evaluated[0].evaluation.edgePct);
  });

  it("a demo exploration trade is made even when the engine would pass", () => {
    const passes = decide(base({ minConfidence: 0.99 }));
    expect(passes.decision.action).toBe("NO_TRADE");
    const forced = decide(base({ minConfidence: 0.99, forceTrade: { investPct: 0.1 } }));
    expect(forced.decision.action).toBe("BUY");
    expect(forced.decision.forced).toBe(true);
    expect(forced.decision.investPct).toBeCloseTo(0.1);
    expect(forced.decision.thesis).toMatch(/DEMO EXPLORATION/);
    expect(forced.chosen).not.toBeNull();
  });

  it("an exploration trade never overrides a veto or an empty shortlist", () => {
    const vetoed = decide(base({ candidates: [candidate({ earningsWithin2d: true })], forceTrade: { investPct: 0.1 } }));
    expect(vetoed.decision.action).toBe("NO_TRADE");
    expect(decide(base({ candidates: [], forceTrade: { investPct: 0.1 } })).decision.action).toBe("NO_TRADE");
  });

  it("the turnover veto threshold is tunable in both directions", () => {
    const thin = candidate({ dollarVolume: 3_000_000 });
    const permissive = decide(base({ candidates: [thin], minConfidence: 0, minEdgePct: -100 }));
    const strict = decide(
      base({ candidates: [thin], minConfidence: 0, minEdgePct: -100, tuning: { ...DEFAULT_TUNING, minTurnoverUsd: 10_000_000 } }),
    );
    expect(permissive.evaluated[0].evaluation.vetoes).toHaveLength(0);
    expect(strict.evaluated[0].evaluation.vetoes.length).toBeGreaterThan(0);
  });
});

describe("tuning registry", () => {
  it("parses to the shipped defaults with no input", () => {
    expect(QuantTuningSchema.parse({})).toEqual(DEFAULT_TUNING);
  });

  it("describes every schema key exactly once", () => {
    const schemaKeys = Object.keys(QuantTuningSchema.shape).sort();
    const described = TUNING_PARAMS.map((p) => p.key).sort();
    expect(described).toEqual(schemaKeys);
    expect(new Set(described).size).toBe(described.length);
  });

  it("gives every parameter a group, a label and a real explanation", () => {
    for (const p of TUNING_PARAMS) {
      expect(TUNING_GROUPS).toContain(p.group);
      expect(p.label.length).toBeGreaterThan(2);
      expect(p.hint.length).toBeGreaterThan(20);
      if (p.kind === "number") {
        expect(typeof p.min).toBe("number");
        expect(typeof p.max).toBe("number");
        expect(p.max!).toBeGreaterThan(p.min!);
      }
    }
  });

  it("keeps every default inside the range the UI offers", () => {
    for (const p of TUNING_PARAMS) {
      if (p.kind !== "number") continue;
      const shown = (DEFAULT_TUNING[p.key] as number) * (p.scale ?? 1);
      expect(shown).toBeGreaterThanOrEqual(p.min!);
      expect(shown).toBeLessThanOrEqual(p.max!);
    }
  });

  it("rejects out-of-range values", () => {
    expect(QuantTuningSchema.safeParse({ kellyFraction: 5 }).success).toBe(false);
    expect(QuantTuningSchema.safeParse({ maxProbability: 0.2 }).success).toBe(false);
    expect(QuantTuningSchema.safeParse({ minRuleSamples: 2 }).success).toBe(false);
    expect(QuantTuningSchema.safeParse({ shortlistSize: 2.5 }).success).toBe(false);
  });

  it("every preset is valid tuning", () => {
    for (const preset of Object.values(TUNING_PRESETS)) {
      expect(QuantTuningSchema.safeParse({ ...DEFAULT_TUNING, ...preset.values }).success).toBe(true);
    }
  });

  it("puts at least one parameter in every group, so no section renders empty", () => {
    for (const group of TUNING_GROUPS) {
      expect(TUNING_PARAMS.filter((p) => p.group === group).length).toBeGreaterThan(0);
    }
  });

  it("exposes the continuous study controls", () => {
    expect(DEFAULT_TUNING.continuousResearch).toBe(true);
    expect(TUNING_PARAMS.filter((p) => p.group === "study").map((p) => p.key)).toContain("studyIntervalMinutes");
  });

  it("presets are ordered from cautious to aggressive", () => {
    const k = (id: keyof typeof TUNING_PRESETS) => ({ ...DEFAULT_TUNING, ...TUNING_PRESETS[id].values }).kellyFraction;
    expect(k("cautious")).toBeLessThan(k("balanced"));
    expect(k("balanced")).toBeLessThan(k("aggressive"));
  });
});

describe("model training options", () => {
  const row = (x: number, y: boolean) => ({ features: { gapSharpe: x, newsSentiment: 0 }, label: y });

  it("leaves frozen features untouched and out of the statistics", () => {
    const state = freshModel();
    const samples = Array.from({ length: 80 }, (_, i) => row((i % 10) / 20, i % 3 === 0));
    const next = train(state, samples, DEFAULT_TUNING, { frozen: new Set(["newsSentiment"]) });
    expect(next.weights.newsSentiment).toBe(state.weights.newsSentiment);
    expect(next.stats.newsSentiment.n).toBe(0);
    expect(next.stats.gapSharpe.n).toBe(80);
  });

  it("skips the reliability curve when asked", () => {
    const samples = Array.from({ length: 30 }, (_, i) => row(0.1, i % 2 === 0));
    const next = train(freshModel(), samples, DEFAULT_TUNING, { calibrate: false });
    expect(next.calibration.reduce((s, b) => s + b.n, 0)).toBe(0);
    expect(next.samples).toBe(30);
    const calibrated = train(freshModel(), samples, DEFAULT_TUNING);
    expect(calibrated.calibration.reduce((s, b) => s + b.n, 0)).toBe(30);
  });

  it("conservatively time-decays live outcomes at a 180-day half-life", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    expect(liveOutcomeWeight("2026-07-01", now)).toBe(1);
    expect(liveOutcomeWeight("2026-01-02", now)).toBeCloseTo(0.5, 8);
    expect(liveOutcomeWeight("not-a-date", now)).toBe(1);
  });

  it("leaves the explicit replay weight unchanged", () => {
    const replay: ReplayRow = { symbol: "TST", date: "2025-01-01", score: 1, features: {}, label: true, gapPct: 0.5 };
    expect(toTrainingSamples([replay], 0.2)[0].weight).toBe(0.2);
  });
});

describe("quant governance", () => {
  const evidence = {
    chronologicalSamples: 120,
    recentSamples: 60,
    recentBrier: 0.16,
    recentBaselineBrier: 0.24,
    calibrationSamples: 120,
    calibrationError: 0.06,
  };

  it("keeps promotion readiness advisory and requires evidence plus measured skill", () => {
    const ready = assessPromotionReadiness(evidence);
    expect(ready.status).toBe("ready_for_review");
    expect(ready.advisoryOnly).toBe(true);
    expect(assessPromotionReadiness({ ...evidence, chronologicalSamples: 99 }).status).toBe("insufficient_evidence");
    expect(assessPromotionReadiness({ ...evidence, recentBrier: 0.25 }).status).toBe("needs_improvement");
  });

  it("separates daily after-cost attribution by market, strategy and evidence", () => {
    const rows = [
      { date: "2026-09-30", market: "US" as const, mode: "live" as const, strategy: "overnight" as const, forced: false, pnl: 20, pnlPct: 3 },
      { date: "2026-09-30", market: "US" as const, mode: "live" as const, strategy: "overnight" as const, forced: false, pnl: -10, pnlPct: -2 },
      { date: "2026-09-30", market: "US" as const, mode: "demo" as const, strategy: "overnight" as const, forced: true, pnl: null, pnlPct: -0.5 },
      { date: "2026-09-30", market: "UK" as const, mode: "dry" as const, strategy: "intraday_momentum" as const, forced: false, pnl: 4, pnlPct: 3 },
    ];
    const report = summariseDailyAttribution(rows);
    expect(report).toHaveLength(3);
    const model = report.find((row) => row.evidenceType === "model_selected")!;
    expect(model.trades).toBe(2);
    expect(model.totalAfterCostPnl).toBe(10);
    expect(model.avgRecordedReturnPct).toBeCloseTo(0.5, 8);
    const exploration = report.find((row) => row.evidenceType === "exploration_override")!;
    expect(exploration.totalAfterCostPnl).toBeNull();
    expect(exploration.avgRecordedReturnPct).toBe(-0.5);
  });
});

describe("history replay", () => {
  const bars = makeBars(220, (i) => (i % 2 === 0 ? 0.6 : -0.1));
  const meta = { symbol: "TST", market: "US" as const, currency: "USD" };
  const dateOf = (b: Bar) => b.date.toISOString().slice(0, 10);

  it("labels each night from the next open and never looks ahead", () => {
    const rows = replaySymbol(bars, meta, DEFAULT_TUNING, { holdoutDays: 0 });
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      const i = bars.findIndex((b) => dateOf(b) === r.date);
      expect(r.gapPct).toBeCloseTo((bars[i + 1].open / bars[i].close - 1) * 100, 8);
    }
    const mid = rows[Math.floor(rows.length / 2)];
    const cut = bars.findIndex((b) => dateOf(b) === mid.date);
    const again = replaySymbol(bars.slice(0, cut + 2), meta, DEFAULT_TUNING, { holdoutDays: 0 });
    expect(again.at(-1)!.features).toEqual(mid.features);
  });

  it("holds out the most recent sessions", () => {
    const all = replaySymbol(bars, meta, DEFAULT_TUNING, { holdoutDays: 0 });
    const held = replaySymbol(bars, meta, DEFAULT_TUNING, { holdoutDays: 10 });
    expect(held.length).toBe(all.length - 10);
  });

  it("skips corporate-action sized gaps and long calendar holes", () => {
    const jump = makeBars(150, (i) => (i === 100 ? 40 : 0.2));
    const rows = replaySymbol(jump, meta, DEFAULT_TUNING, { holdoutDays: 0 });
    expect(rows.some((r) => Math.abs(r.gapPct) > 25)).toBe(false);

    const holes = makeBars(150, () => 0.2).map((b, i) => (i > 80 ? { ...b, date: new Date(b.date.getTime() + 10 * 86_400_000) } : b));
    const withHole = replaySymbol(holes, meta, DEFAULT_TUNING, { holdoutDays: 0 });
    expect(withHole.every((r) => r.date !== dateOf(holes[80]))).toBe(true);
  });

  it("keeps only the top share of each date by score", () => {
    const mk = (symbol: string, date: string, score: number): ReplayRow => ({ symbol, date, score, features: {}, label: true, gapPct: 0 });
    const rows = [mk("A", "2024-01-02", 3), mk("B", "2024-01-02", 1), mk("C", "2024-01-02", 2), mk("D", "2024-01-02", 0), mk("A", "2024-01-03", 1)];
    const kept = selectShortlisted(rows, 0.25);
    expect(kept.map((r) => `${r.date}:${r.symbol}`)).toEqual(["2024-01-02:A", "2024-01-03:A"]);
  });

  it("freezes exactly the features a bar series cannot supply", () => {
    for (const k of ["newsSentiment", "marketBias", "trend", "earningsSoon", "analystTilt", "shortInterest"]) expect(REPLAY_FROZEN_FEATURES.has(k)).toBe(true);
    for (const k of ["gapSharpe", "closeLocation", "relVolume", "gapLast", "gapTail"]) expect(REPLAY_FROZEN_FEATURES.has(k)).toBe(false);
  });

  it("rebuilds market-regime features from index and VIX history", () => {
    const index = makeBars(220, () => 0.1);
    const vix = makeBars(220, (i) => (i % 7 === 0 ? 5 : -0.5)).map((b) => ({ ...b, close: 12 + (b.close % 20) }));
    const series = marketContextSeries(index, vix);
    expect(series.size).toBeGreaterThan(100);
    const ctx = series.get(dateOf(index[150]))!;
    expect(ctx.trendRegime).toBe("bull");
    expect(ctx.vix).toBeCloseTo(vix[150].close, 8);
    expect(ctx.vixChangePct).toBeCloseTo((vix[150].close / vix[149].close - 1) * 100, 8);

    const withCtx = replaySymbol(bars, meta, DEFAULT_TUNING, { holdoutDays: 0, marketContext: series });
    const without = replaySymbol(bars, meta, DEFAULT_TUNING, { holdoutDays: 0 });
    expect(withCtx.length).toBeGreaterThan(50);
    expect(withCtx.length).toBeLessThanOrEqual(without.length);
    expect(new Set(withCtx.map((r) => r.features.volRegime)).size).toBeGreaterThan(1);
    expect(new Set(without.map((r) => r.features.volRegime)).size).toBe(1);

    expect(replayFrozenFeatures(true).has("volRegime")).toBe(false);
    expect(replayFrozenFeatures(true).has("newsSentiment")).toBe(true);
    expect(replayFrozenFeatures(false).has("volRegime")).toBe(true);
  });
});

describe("accuracy", () => {
  it("computes AUC with ties as half", () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [true, true, false, false])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [true, true, false, false])).toBe(0);
    expect(auc([0.5, 0.5], [true, false])).toBe(0.5);
    expect(auc([0.5, 0.6], [true, true])).toBeNull();
  });

  it("scores a perfect model below the base-rate Brier", () => {
    const rows = [0.9, 0.9, 0.1, 0.1].map((p, i) => ({ probability: p, screenScore: 4 - i, label: i < 2 }));
    const r = accuracyOf(rows)!;
    expect(r.brier).toBeCloseTo(0.01, 6);
    expect(r.baselineBrier).toBeCloseTo(0.25, 6);
    expect(r.modelAuc).toBe(1);
    expect(accuracyOf([])).toBeNull();
  });
});
