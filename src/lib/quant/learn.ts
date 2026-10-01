/**
 * The learning loop.
 *
 * Every shortlisted candidate - picked or not - has its actual close-to-next-open return recorded,
 * which is roughly eight labelled examples per trading day. This module turns those into:
 *
 *   1. Updated model coefficients and calibration (`trainFromOutcomes`).
 *   2. Mined lesson rules: conditional patterns that pass a significance test and a minimum sample
 *      size, stored with an executable rule so they actually change future decisions.
 *   3. A per-trade review, derived from predicted-versus-realised and from what the rest of the
 *      shortlist did, which is what separates a wrong thesis from an unlucky night.
 */

import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import { getDb, schema } from "../db";
import { breakEvenPct, roundTripCostPct } from "./costs";
import { FEATURES, FEATURE_BY_KEY } from "./features";
import { diagnostics, loadModel, predict, saveModel, train, type ModelState, type TrainingSample } from "./model";
import { binomialPValue, clamp, logit, mean, median, shrunkRate, quantile } from "./stats";
import type { LessonRule, MarketContext, Review } from "./schemas";
import { DEFAULT_TUNING, type QuantTuning } from "./tuning";
import { getTuning } from "../config";
import { getKv } from "../kv";
import { accuracyOf } from "./accuracy";
import { chronologicalEvaluation } from "./evaluation";
import { BACKFILL_STATS_KEY, type BackfillStats } from "./backfill";
import {
  governanceThresholds,
  governedChampion,
  persistTrainedVersion,
  trainingBase,
  type ModelScope,
} from "./governance";

const { candidates, decisions, runs, lessons } = schema;

/** Live evidence loses half its training influence after 180 days; replay/backfill weights are unchanged. */
export const LIVE_OUTCOME_HALF_LIFE_DAYS = 180;

export function liveOutcomeWeight(tradingDate: string, now = new Date()): number {
  const observedAt = Date.parse(`${tradingDate}T00:00:00Z`);
  if (!Number.isFinite(observedAt)) return 1;
  const ageDays = Math.max(0, (now.getTime() - observedAt) / 86_400_000);
  return 0.5 ** (ageDays / LIVE_OUTCOME_HALF_LIFE_DAYS);
}

export interface LabelledRow {
  id: number;
  tradingDate: string;
  ticker: string;
  market: "US" | "UK";
  features: Record<string, number>;
  returnPct: number;
  costPct: number;
  /** True when the realised move cleared costs. */
  label: boolean;
  /** What the engine said at the time, when it evaluated this candidate. */
  probability?: number | null;
  screenScore?: number | null;
  regime?: "unknown" | "calm" | "normal" | "stressed";
}

async function labelledRows(afterId = 0, tuning: QuantTuning = DEFAULT_TUNING, market?: "US" | "UK"): Promise<LabelledRow[]> {
  const rows = await getDb()
    .select({ c: candidates, market: runs.market, tradingDate: runs.tradingDate, marketContext: decisions.marketContext })
    .from(candidates)
    .innerJoin(runs, eq(candidates.runId, runs.id))
    .leftJoin(decisions, eq(decisions.runId, runs.id))
    .where(and(isNotNull(candidates.overnightReturnPct), isNotNull(candidates.features), gt(candidates.id, afterId)))
    .orderBy(asc(candidates.id));

  return rows
    .filter((r) => r.c.features && r.c.overnightReturnPct != null)
    .map(({ c, market, tradingDate, marketContext }) => {
      // Same hurdle the decision uses (costs plus opening-auction slippage), or the model learns a different target.
      const cost = breakEvenPct(
        market,
        {
          atrPct: Number((c.signals as Record<string, number> | null)?.atrPct ?? 2),
          dollarVolume: Number((c.signals as Record<string, number> | null)?.dollarVolume ?? 5e7),
        },
        tuning,
      );
      return {
        id: c.id,
        tradingDate,
        ticker: c.ticker,
        market,
        features: c.features as Record<string, number>,
        returnPct: c.overnightReturnPct!,
        costPct: cost,
        label: c.overnightReturnPct! > cost,
        probability: typeof (c.evaluation as { probability?: unknown } | null)?.probability === "number" ? (c.evaluation as { probability: number }).probability : null,
        screenScore: c.screenScore,
        regime: (marketContext as MarketContext | null)?.volRegime,
      };
    })
    .filter((row) => !market || row.market === market);
}

/** Trains on every scored candidate not seen before. Returns how many rows were consumed. */
export async function trainFromOutcomes(now = new Date()): Promise<{ trained: number; state: ModelState }> {
  const tuning = await getTuning();
  let sharedState = (await trainingBase("shared")).state;
  let sharedTrained = 0;
  const scopes: ModelScope[] = ["shared", "US", "UK"];

  for (const scope of scopes) {
    const base = await trainingBase(scope);
    const market = scope === "shared" ? undefined : scope;
    const rows = await labelledRows(base.state.lastCandidateId, tuning, market);
    if (!rows.length) continue;
    if (market) {
      const total = await labelledRows(0, tuning, market);
      if (total.length < governanceThresholds().marketTrainingSamples) continue;
    }

    const samples: TrainingSample[] = rows.map((row) => ({
      features: row.features,
      label: row.label,
      weight: liveOutcomeWeight(row.tradingDate, now),
    }));
    const positives = rows.filter((row) => row.label).length / rows.length;
    const brier = rows.reduce((sum, row) => {
      const probability = predict(base.state, row.features).probability;
      return sum + (probability - (row.label ? 1 : 0)) ** 2;
    }, 0) / rows.length;
    const baselineBrier = rows.reduce((sum, row) => sum + (positives - (row.label ? 1 : 0)) ** 2, 0) / rows.length;
    const next = train(base.state, samples, tuning);
    next.lastCandidateId = Math.max(base.state.lastCandidateId, ...rows.map((row) => row.id));
    await persistTrainedVersion({
      scope,
      parentVersionId: base.id,
      state: next,
      tuning,
      window: {
        from: rows[0].tradingDate,
        to: rows.at(-1)!.tradingDate,
        firstCandidateId: rows[0].id,
        lastCandidateId: rows.at(-1)!.id,
      },
      metrics: {
        brier,
        baselineBrier,
        meanAfterCostReturnPct: rows.reduce((sum, row) => sum + row.returnPct - row.costPct, 0) / rows.length,
      },
      reason: `trained on ${rows.length} newly observed ${scope} overnight outcome(s)`,
    });
    if (scope === "shared") {
      sharedState = next;
      sharedTrained = rows.length;
    }
  }
  return { trained: sharedTrained, state: sharedState };
}

interface Split {
  feature: string;
  label: string;
  min: number | null;
  max: number | null;
  describe: string;
}

/** Candidate splits: the top and bottom third of each feature's observed range. */
function splitsFor(values: number[], feature: string): Split[] {
  const def = FEATURE_BY_KEY.get(feature);
  if (!def) return [];
  const lo = quantile(values, 1 / 3);
  const hi = quantile(values, 2 / 3);
  if (!(hi > lo)) return [];
  const label = def.label.toLowerCase();
  return [
    { feature, label: def.label, min: null, max: lo, describe: `when ${label} is in its lowest third (below ${lo.toFixed(2)})` },
    { feature, label: def.label, min: hi, max: null, describe: `when ${label} is in its highest third (above ${hi.toFixed(2)})` },
  ];
}

export interface MinedLesson {
  text: string;
  tags: string[];
  rule: LessonRule;
}

/**
 * Looks for conditions under which the shortlist reliably does better or worse than its own base
 * rate. A pattern must clear a minimum sample size and a two-sided binomial test before it is kept,
 * and the resulting adjustment is shrunk, so noise cannot turn into dogma.
 */
export function mineLessons(rows: LabelledRow[], tuning: QuantTuning = DEFAULT_TUNING): MinedLesson[] {
  const MIN_RULE_SAMPLES = tuning.minRuleSamples;
  const MAX_RULE_P_VALUE = tuning.maxRulePValue;
  const MAX_ACTIVE_RULES = tuning.maxActiveRules;
  if (rows.length < MIN_RULE_SAMPLES * 2) return [];
  const baseRate = rows.filter((r) => r.label).length / rows.length;
  if (baseRate <= 0 || baseRate >= 1) return [];

  const found: MinedLesson[] = [];
  const markets: ("US" | "UK" | null)[] = [null, "US", "UK"];

  for (const market of markets) {
    const scope = market ? rows.filter((r) => r.market === market) : rows;
    if (scope.length < MIN_RULE_SAMPLES * 2) continue;
    const scopeRate = scope.filter((r) => r.label).length / scope.length;

    for (const def of FEATURES) {
      const values = scope.map((r) => r.features[def.key]).filter((v) => Number.isFinite(v));
      if (values.length < MIN_RULE_SAMPLES * 2) continue;

      for (const split of splitsFor(values, def.key)) {
        const inSplit = scope.filter((r) => {
          const v = r.features[def.key];
          if (!Number.isFinite(v)) return false;
          return (split.min == null || v >= split.min) && (split.max == null || v <= split.max);
        });
        if (inSplit.length < MIN_RULE_SAMPLES) continue;

        const wins = inSplit.filter((r) => r.label).length;
        const p = binomialPValue(wins, inSplit.length, scopeRate);
        if (p > MAX_RULE_P_VALUE) continue;

        const observed = shrunkRate(wins, inSplit.length, scopeRate, 12);
        const adjustment = clamp(logit(observed) - logit(scopeRate), -tuning.maxRuleAdjustment, tuning.maxRuleAdjustment);
        if (Math.abs(adjustment) < 0.12) continue;

        const avg = mean(inSplit.map((r) => r.returnPct));
        const direction = adjustment > 0 ? "better" : "worse";
        const scopeText = market ? `${market} candidates` : "candidates";
        found.push({
          text: `${scopeText} do ${direction} than usual ${split.describe}: ${wins}/${inSplit.length} cleared costs (${(observed * 100).toFixed(0)}% versus a ${(scopeRate * 100).toFixed(0)}% base rate), averaging ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}% overnight.`,
          tags: [def.key, market ?? "all", adjustment > 0 ? "positive" : "negative"],
          rule: {
            feature: def.key,
            min: split.min,
            max: split.max,
            market,
            samples: inSplit.length,
            winRate: observed,
            avgReturnPct: avg,
            pValue: p,
            adjustment,
          },
        });
      }
    }
  }

  // Keep the strongest, most evidenced rules and at most one per feature/market pair.
  const seen = new Set<string>();
  return found
    .sort((a, b) => Math.abs(b.rule.adjustment) * Math.log(b.rule.samples) - Math.abs(a.rule.adjustment) * Math.log(a.rule.samples))
    .filter((l) => {
      const k = `${l.rule.feature}:${l.rule.market ?? "all"}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_ACTIVE_RULES);
}

/**
 * Re-mines every rule from scratch and replaces the active set. Rules are derived, not accumulated,
 * so a pattern that stops holding simply stops being regenerated instead of lingering forever.
 */
export async function refreshLessons(): Promise<{ active: number }> {
  const db = getDb();
  const tuning = await getTuning();
  const rows = await labelledRows(0, tuning);
  const mined = mineLessons(rows, tuning);

  const existing = await db.select().from(lessons).where(isNotNull(lessons.rule));
  for (const row of existing) {
    if (row.active) await db.update(lessons).set({ active: false }).where(eq(lessons.id, row.id));
  }

  for (const l of mined) {
    const match = existing.find((e) => e.rule?.feature === l.rule.feature && (e.rule?.market ?? null) === l.rule.market);
    if (match) await db.update(lessons).set({ text: l.text, tags: l.tags, rule: l.rule, active: true }).where(eq(lessons.id, match.id));
    else await db.insert(lessons).values({ text: l.text, tags: l.tags, rule: l.rule, active: true });
  }
  return { active: mined.length };
}

export interface TradeReviewInput {
  ticker: string;
  market: "US" | "UK";
  confidence: number;
  expectedMovePct: number;
  pnlPct: number | null;
  costPct: number;
  shortlistOutcomes: { ticker: string; overnightReturnPct: number | null; picked: boolean }[];
}

/**
 * Deterministic post-mortem. The interesting question is never "did it go up" but "did it go up for
 * the reason predicted, and did the rest of the shortlist do the same", which the counterfactual
 * outcomes answer directly.
 */
export function reviewTrade(i: TradeReviewInput): Review {
  const pnl = i.pnlPct;
  const others = i.shortlistOutcomes.filter((o) => !o.picked && o.overnightReturnPct != null).map((o) => o.overnightReturnPct!);
  const peer = others.length >= 3 ? median(others) : null;

  if (pnl == null) {
    return { verdict: "inconclusive", summary: "The trade closed without a usable return, so there is nothing to learn from it.", lessons: [] };
  }

  const beatPeers = peer == null ? null : pnl - peer;
  const clearedCosts = pnl > i.costPct;
  const predictedUp = i.expectedMovePct > 0;
  const surprise = Math.abs(pnl - i.expectedMovePct);

  let verdict: Review["verdict"];
  if (clearedCosts && predictedUp && surprise < Math.max(1, Math.abs(i.expectedMovePct) * 2)) verdict = "thesis_right";
  else if (clearedCosts && beatPeers != null && beatPeers < 0) verdict = "right_for_wrong_reason";
  else if (clearedCosts) verdict = "lucky";
  else if (beatPeers != null && beatPeers > 0) verdict = "unlucky";
  else if (predictedUp && pnl < -Math.max(1, i.expectedMovePct)) verdict = "thesis_wrong";
  else verdict = "inconclusive";

  const peerText =
    peer == null
      ? "There were too few scored peers to compare against."
      : `The rest of the shortlist averaged ${peer >= 0 ? "+" : ""}${peer.toFixed(2)}% overnight, so this pick was ${beatPeers! >= 0 ? "ahead of" : "behind"} its peers by ${Math.abs(beatPeers!).toFixed(2)} points.`;

  const summary = `Predicted ${(i.confidence * 100).toFixed(0)}% to clear a ${i.costPct.toFixed(2)}% cost hurdle with an expected ${i.expectedMovePct >= 0 ? "+" : ""}${i.expectedMovePct.toFixed(2)}%; realised ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%. ${peerText}`;

  // Narrative lessons are not written here: rules are mined from the whole dataset in refreshLessons,
  // where a single night cannot masquerade as a pattern.
  return { verdict, summary, lessons: [] };
}

const PROMOTION_MIN_PREDICTIONS = 100;
const PROMOTION_MAX_CALIBRATION_ERROR = 0.1;

export interface PromotionEvidence {
  chronologicalSamples: number;
  recentSamples: number;
  recentBrier: number | null;
  recentBaselineBrier: number | null;
  calibrationSamples: number;
  calibrationError: number | null;
}

export interface PromotionReadiness {
  status: "insufficient_evidence" | "needs_improvement" | "ready_for_review";
  checks: { key: "samples" | "brier" | "calibration"; label: string; passed: boolean; detail: string }[];
  advisoryOnly: true;
}

/**
 * A read-only governance signal. It deliberately has no persistence or execution path: even a
 * "ready" result only invites human review and can never promote a model or change trading.
 */
export function assessPromotionReadiness(e: PromotionEvidence): PromotionReadiness {
  const enoughSamples = e.chronologicalSamples >= PROMOTION_MIN_PREDICTIONS && e.recentSamples >= PROMOTION_MIN_PREDICTIONS / 2;
  const beatsBaseline =
    e.recentBrier != null &&
    e.recentBaselineBrier != null &&
    e.recentBrier < e.recentBaselineBrier;
  const calibrated =
    e.calibrationSamples >= PROMOTION_MIN_PREDICTIONS &&
    e.calibrationError != null &&
    e.calibrationError <= PROMOTION_MAX_CALIBRATION_ERROR;
  const checks: PromotionReadiness["checks"] = [
    {
      key: "samples",
      label: "Live chronological evidence",
      passed: enoughSamples,
      detail: `${e.chronologicalSamples}/${PROMOTION_MIN_PREDICTIONS} predictions; ${e.recentSamples}/${PROMOTION_MIN_PREDICTIONS / 2} in the recent half`,
    },
    {
      key: "brier",
      label: "Recent Brier beats baseline",
      passed: beatsBaseline,
      detail:
        e.recentBrier == null || e.recentBaselineBrier == null
          ? "not measurable yet"
          : `${e.recentBrier.toFixed(3)} vs ${e.recentBaselineBrier.toFixed(3)} baseline (lower is better)`,
    },
    {
      key: "calibration",
      label: "Calibration evidence",
      passed: calibrated,
      detail: `${e.calibrationSamples}/${PROMOTION_MIN_PREDICTIONS} calibrated outcomes; error ${
        e.calibrationError == null ? "not measurable" : `${(e.calibrationError * 100).toFixed(1)}pp`
      } (limit ${(PROMOTION_MAX_CALIBRATION_ERROR * 100).toFixed(0)}pp)`,
    },
  ];
  const status = !enoughSamples || e.calibrationSamples < PROMOTION_MIN_PREDICTIONS
    ? "insufficient_evidence"
    : checks.every((check) => check.passed)
      ? "ready_for_review"
      : "needs_improvement";
  return { status, checks, advisoryOnly: true };
}

/** Everything the learning page needs about the model itself. */
export async function getModelReport() {
  const state = (await governedChampion("shared")).state;
  const d = diagnostics(state);
  const rows = await labelledRows();
  const base = rows.length ? rows.filter((r) => r.label).length / rows.length : null;
  const accuracy = accuracyOf(
    rows.flatMap((r) => (r.probability != null && r.screenScore != null ? [{ probability: r.probability, screenScore: r.screenScore, label: r.label }] : [])),
  );
  const walkForward = chronologicalEvaluation(
    rows.flatMap((r) =>
      r.probability != null && r.screenScore != null
        ? [{
            id: r.id,
            market: r.market,
            probability: r.probability,
            screenScore: r.screenScore,
            label: r.label,
            regime: r.regime,
          }]
        : [],
    ),
  );
  const backfill = (await getKv<BackfillStats>(BACKFILL_STATS_KEY))?.value ?? null;
  const recent = walkForward?.slices.find((slice) => slice.label === "Recent half") ?? null;
  const promotion = assessPromotionReadiness({
    chronologicalSamples: walkForward?.n ?? 0,
    recentSamples: recent?.n ?? 0,
    recentBrier: recent?.accuracy?.brier ?? null,
    recentBaselineBrier: recent?.accuracy?.baselineBrier ?? null,
    calibrationSamples: d.reliability.reduce((sum, bucket) => sum + bucket.n, 0),
    calibrationError: d.calibrationError,
  });
  const activeRules = await getDb()
    .select()
    .from(lessons)
    .where(and(eq(lessons.active, true), isNotNull(lessons.rule)))
    .orderBy(desc(lessons.id));

  return {
    samples: d.samples,
    labelledRows: rows.length,
    baseRate: base,
    calibrationError: d.calibrationError,
    accuracy,
    walkForward,
    promotion,
    backfill,
    reliability: d.reliability,
    learned: d.learned.slice(0, 10).map((l) => ({ ...l, label: FEATURE_BY_KEY.get(l.key)?.label ?? l.key })),
    rules: activeRules.map((r) => ({ id: r.id, text: r.text, rule: r.rule })),
    updatedAt: state.updatedAt,
  };
}

/** Convenience used by the finalize step: train, then re-derive the rule set. */
export async function runLearningCycle(): Promise<{ trained: number; activeRules: number }> {
  const { trained } = await trainFromOutcomes();
  const { active } = await refreshLessons();
  return { trained, activeRules: active };
}

/** Exported for the trade review: cost hurdle used when the decision was taken. */
export const reviewCostPct = (market: "US" | "UK") => roundTripCostPct(market);

/** Re-export so callers do not need to reach into ./model directly. */
export { loadModel, saveModel };
