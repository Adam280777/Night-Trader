/**
 * The decision engine.
 *
 * For each shortlisted name it builds three independent views of tonight and combines them:
 *
 *   1. The learned logistic model (cross-sectional: what has worked across all names).
 *   2. Conditional historical analogues (name-specific: what this stock does from this setup).
 *   3. Mined lesson rules (explicit corrections the learning loop has earned the right to make).
 *
 * The blend is weighted by how much evidence each view actually has, converted into an expected
 * value after realistic costs, then charged for estimation uncertainty. Only a positive
 * risk-adjusted edge buys anything; otherwise the answer is NO_TRADE, which is free.
 */

import { breakEvenPct } from "./costs";
import { extractFeatures, type FeatureContext, type FeatureVector } from "./features";
import { buildAttributions, buildExitPlan, buildNoTradeThesis, buildRisks, buildThesis, whyNotReason } from "./explain";
import { predict, type ModelState } from "./model";
import { regimeVolMultiplier } from "./regime";
import { applyRules, type ActiveRule } from "./rules";
import type { Candidate } from "./screener";
import type { AnalogueResult } from "./analogues";
import type { Decision, Evaluation, MarketContext, Research } from "./schemas";
import { clamp, finite, logit, normalCdf, normalMeanAbove, normalMeanBelow, proportionSe, sigmoid } from "./stats";
import { DEFAULT_TUNING, type QuantTuning } from "./tuning";

export interface CandidateInput {
  candidate: Candidate;
  research: Research | null;
  analogue: AnalogueResult | null;
}

export interface DecideInput {
  market: "US" | "UK";
  candidates: CandidateInput[];
  context: MarketContext | null;
  model: ModelState;
  rules: ActiveRule[];
  account: { totalValue: number; availableCash: number; currency: string };
  minutesToClose: number;
  /** Minimum calibrated probability required before a BUY is even considered. */
  minConfidence: number;
  /** Minimum net edge in percent, after costs. */
  minEdgePct: number;
  /** Every tunable constant in the engine. Falls back to the shipped defaults. */
  tuning?: QuantTuning;
}

export interface Evaluated {
  input: CandidateInput;
  features: FeatureVector;
  ctx: FeatureContext;
  evaluation: Evaluation;
  appliedLessons: string[];
}

/**
 * Expected overnight return given a probability of clearing `threshold`, using the analogue
 * distribution's conditional means where available and a normal approximation otherwise.
 */
function expectedMove(
  p: number,
  threshold: number,
  sigma: number,
  analogue: AnalogueResult | null,
  drift: number,
  minSamples: number,
): number {
  if (analogue && analogue.samples >= minSamples) {
    const { win, loss } = analogue.conditionalMeans(threshold);
    return p * win + (1 - p) * loss;
  }
  const win = normalMeanAbove(drift, sigma, threshold);
  const loss = normalMeanBelow(drift, sigma, threshold);
  return p * win + (1 - p) * loss;
}

export function evaluateCandidate(i: DecideInput, input: CandidateInput): Evaluated {
  const t = i.tuning ?? DEFAULT_TUNING;
  const { candidate: c, research, analogue } = input;
  const ctx: FeatureContext = { market: i.market, signals: c.signals, research, context: i.context };
  const features = extractFeatures(ctx);

  const costPct = breakEvenPct(i.market, c.signals, t);
  const prediction = predict(i.model, features);
  const rules = applyRules(i.rules, i.market, features, t);

  // --- Blend the two probability views in log-odds space -------------------------------------
  const analogueSamples = analogue?.samples ?? 0;
  const hasAnalogue = analogueSamples >= t.minAnalogueSamples;
  const analogueProbability = analogue && hasAnalogue ? analogue.probAbove(costPct) : null;
  const analogueWeight =
    analogueProbability == null
      ? 0
      : clamp(analogueSamples / (analogueSamples + t.analoguePriorWeight), 0, t.maxAnalogueWeight);

  const blendedLogOdds =
    logit(prediction.probability) * (1 - analogueWeight) +
    (analogueProbability != null ? logit(analogueProbability) * analogueWeight : 0) +
    rules.adjustment;
  const probability = clamp(sigmoid(blendedLogOdds), 0.01, t.maxProbability);

  // --- Dispersion and expected value ----------------------------------------------------------
  const baseSigma = analogue && hasAnalogue ? analogue.sigmaPct : Math.max(0.3, c.signals.gapStdPct);
  const sigmaPct = clamp(finite(baseSigma, 1) * regimeVolMultiplier(i.context?.vix ?? null), 0.25, 12);
  const drift = analogue && hasAnalogue ? analogue.meanPct : c.signals.gapMeanPct;

  const expectedMovePct = finite(expectedMove(probability, costPct, sigmaPct, analogue, drift, t.minAnalogueSamples));
  const edgePct = expectedMovePct - costPct;

  // Charge for how little we actually know: uncertainty in p, plus uncertainty in the mean itself.
  const effectiveN = Math.max(8, analogueSamples + Math.min(i.model.samples, 400) / 8);
  const probSe = proportionSe(probability, effectiveN);
  const meanSe = sigmaPct / Math.sqrt(effectiveN);
  const edgeSe = Math.sqrt((probSe * 2 * sigmaPct) ** 2 + meanSe ** 2);
  const riskAdjustedEdgePct = edgePct - t.uncertaintyPenalty * edgeSe;

  // --- Sizing: a fraction of Kelly on the risk-adjusted edge -----------------------------------
  const mu = riskAdjustedEdgePct / 100;
  const s = sigmaPct / 100;
  const kellyFraction = clamp(s > 0 ? (mu / (s * s)) * t.kellyFraction : 0, 0, 1);

  // --- Hard flags ------------------------------------------------------------------------------
  const vetoes: string[] = [];
  if (t.vetoBinaryEvent && research?.earningsOrBinaryEventBeforeNextOpen) vetoes.push("a binary event resolves before the next open");
  if (t.vetoEarnings && c.signals.earningsWithin2d) vetoes.push("earnings within two days");
  if (t.vetoHighNewsRisk && research?.overnightRisk === "high") vetoes.push("headline-driven overnight risk is high");
  if (c.signals.dollarVolume > 0 && c.signals.dollarVolume < t.minTurnoverUsd)
    vetoes.push("turnover is too thin to exit into the open reliably");
  if (t.vetoStressedVol && i.context?.volRegime === "stressed") vetoes.push("volatility regime is stressed");

  const attributions = buildAttributions(prediction.contributions, ctx);
  if (rules.applied.length) {
    attributions.push({
      key: "lessons",
      label: "Learned lessons",
      value: rules.adjustment,
      display: rules.applied.join("; "),
      contribution: rules.adjustment,
    });
    attributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }

  const evaluation: Evaluation = {
    ticker: c.ticker,
    probability,
    modelProbability: prediction.probability,
    analogueProbability,
    analogueSamples: finite(analogueSamples),
    expectedMovePct,
    edgePct: finite(edgePct),
    riskAdjustedEdgePct: finite(riskAdjustedEdgePct),
    sigmaPct,
    costPct,
    kellyFraction,
    attributions,
    vetoes,
  };

  return { input, features, ctx, evaluation, appliedLessons: rules.applied };
}

export interface DecideOutput {
  decision: Decision;
  evaluated: Evaluated[];
  chosen: Evaluated | null;
  notes: string[];
}

export function decide(i: DecideInput): DecideOutput {
  const notes: string[] = [];
  const evaluated = i.candidates.map((c) => evaluateCandidate(i, c));
  const ranked = [...evaluated].sort((a, b) => b.evaluation.riskAdjustedEdgePct - a.evaluation.riskAdjustedEdgePct);

  const noTrade = (reason: string, best: Evaluated | null): DecideOutput => ({
    decision: {
      action: "NO_TRADE",
      ticker: null,
      confidence: best ? best.evaluation.probability : 0,
      investPct: 0,
      expectedMovePct: best ? best.evaluation.expectedMovePct : 0,
      thesis: buildNoTradeThesis(best?.evaluation ?? null, reason, evaluated.length),
      risks: best ? buildRisks(best.evaluation, best.ctx) : "No position, so no overnight exposure.",
      exitPlan: "No position to exit.",
      whyNotOthers: ranked.slice(0, 6).map((e) => ({ ticker: e.evaluation.ticker, reason: whyNotReason(e.evaluation) })),
      lessonsApplied: [...new Set(evaluated.flatMap((e) => e.appliedLessons))],
      evaluations: ranked.map((e) => e.evaluation),
    },
    evaluated,
    chosen: null,
    notes,
  });

  if (ranked.length === 0) return noTrade("No candidate produced a usable evaluation.", null);

  const tradeable = ranked.filter((e) => e.evaluation.vetoes.length === 0);
  if (tradeable.length === 0) {
    return noTrade(`Every candidate was flagged: ${ranked[0].evaluation.vetoes.join("; ")}.`, ranked[0]);
  }

  const best = tradeable[0];
  const e = best.evaluation;

  if (e.probability < i.minConfidence) {
    return noTrade(
      `The best candidate is only ${(e.probability * 100).toFixed(0)}% likely to clear costs, under the ${(i.minConfidence * 100).toFixed(0)}% minimum.`,
      best,
    );
  }
  if (e.riskAdjustedEdgePct <= 0) {
    return noTrade(
      `Its ${(e.edgePct >= 0 ? "" : "negative ")}edge of ${e.edgePct.toFixed(2)}% does not survive the ${(e.edgePct - e.riskAdjustedEdgePct).toFixed(2)}% charged for estimation uncertainty.`,
      best,
    );
  }
  if (e.edgePct < i.minEdgePct) {
    return noTrade(`Its ${e.edgePct.toFixed(2)}% edge after costs is below the ${i.minEdgePct.toFixed(2)}% minimum.`, best);
  }
  if (e.kellyFraction < (i.tuning ?? DEFAULT_TUNING).minKellyFraction) {
    return noTrade("The optimal stake rounds to nothing, so the edge is not worth the exposure.", best);
  }

  const name = best.input.candidate.name || e.ticker;
  return {
    decision: {
      action: "BUY",
      ticker: e.ticker,
      confidence: e.probability,
      investPct: e.kellyFraction,
      expectedMovePct: e.expectedMovePct,
      thesis: buildThesis(e, best.ctx, name),
      risks: buildRisks(e, best.ctx),
      exitPlan: buildExitPlan(i.market),
      whyNotOthers: ranked
        .filter((x) => x !== best)
        .slice(0, 6)
        .map((x) => ({ ticker: x.evaluation.ticker, reason: whyNotReason(x.evaluation) })),
      lessonsApplied: best.appliedLessons,
      evaluations: ranked.map((x) => x.evaluation),
    },
    evaluated,
    chosen: best,
    notes,
  };
}

/** Probability the overnight move exceeds `t` under a normal fit; used by tests and diagnostics. */
export const normalProbAbove = (t: number, mu: number, sigma: number) => 1 - normalCdf(t, mu, sigma);
