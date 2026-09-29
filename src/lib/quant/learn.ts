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
import { roundTripCostPct } from "./costs";
import { FEATURES, FEATURE_BY_KEY } from "./features";
import { diagnostics, loadModel, saveModel, train, type ModelState, type TrainingSample } from "./model";
import { binomialPValue, clamp, logit, mean, median, shrunkRate, quantile } from "./stats";
import type { LessonRule, Review } from "./schemas";
import { DEFAULT_TUNING, type QuantTuning } from "./tuning";
import { getTuning } from "../config";

const { candidates, runs, lessons } = schema;

export interface LabelledRow {
  id: number;
  ticker: string;
  market: "US" | "UK";
  features: Record<string, number>;
  returnPct: number;
  costPct: number;
  /** True when the realised move cleared costs. */
  label: boolean;
}

async function labelledRows(afterId = 0, tuning: QuantTuning = DEFAULT_TUNING): Promise<LabelledRow[]> {
  const rows = await getDb()
    .select({ c: candidates, market: runs.market })
    .from(candidates)
    .innerJoin(runs, eq(candidates.runId, runs.id))
    .where(and(isNotNull(candidates.overnightReturnPct), isNotNull(candidates.features), gt(candidates.id, afterId)))
    .orderBy(asc(candidates.id));

  return rows
    .filter((r) => r.c.features && r.c.overnightReturnPct != null)
    .map(({ c, market }) => {
      const cost = roundTripCostPct(
        market,
        {
          atrPct: Number((c.signals as Record<string, number> | null)?.atrPct ?? 2),
          dollarVolume: Number((c.signals as Record<string, number> | null)?.dollarVolume ?? 5e7),
        },
        tuning,
      );
      return {
        id: c.id,
        ticker: c.ticker,
        market,
        features: c.features as Record<string, number>,
        returnPct: c.overnightReturnPct!,
        costPct: cost,
        label: c.overnightReturnPct! > cost,
      };
    });
}

/** Trains on every scored candidate not seen before. Returns how many rows were consumed. */
export async function trainFromOutcomes(): Promise<{ trained: number; state: ModelState }> {
  const tuning = await getTuning();
  const state = await loadModel();
  const rows = await labelledRows(state.lastCandidateId, tuning);
  if (rows.length === 0) return { trained: 0, state };

  const samples: TrainingSample[] = rows.map((r) => ({ features: r.features, label: r.label }));
  const next = train(state, samples, tuning);
  next.lastCandidateId = Math.max(state.lastCandidateId, ...rows.map((r) => r.id));
  await saveModel(next);
  return { trained: rows.length, state: next };
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

/** Everything the learning page needs about the model itself. */
export async function getModelReport() {
  const state = await loadModel();
  const d = diagnostics(state);
  const rows = await labelledRows();
  const base = rows.length ? rows.filter((r) => r.label).length / rows.length : null;
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
