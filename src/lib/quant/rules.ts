/**
 * Lessons as executable rules.
 *
 * A lesson is only useful if it changes behaviour, so each mined lesson carries a machine-readable
 * rule: a feature, a range, an optional market, and a log-odds adjustment. Candidates matching the
 * rule are nudged before the decision is taken, which closes the learning loop properly.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "../db";
import { clamp } from "./stats";
import type { FeatureVector } from "./features";
import type { LessonRule } from "./schemas";
import { DEFAULT_TUNING, type QuantTuning } from "./tuning";

export interface ActiveRule {
  id: number;
  text: string;
  rule: LessonRule;
}

export async function loadRules(limit = 40): Promise<ActiveRule[]> {
  const rows = await getDb()
    .select()
    .from(schema.lessons)
    .where(and(eq(schema.lessons.active, true), isNotNull(schema.lessons.rule)))
    .limit(limit);
  return rows
    .filter((r): r is typeof r & { rule: LessonRule } => !!r.rule)
    .map((r) => ({ id: r.id, text: r.text, rule: r.rule }));
}

export function matchesRule(rule: LessonRule, market: "US" | "UK", features: FeatureVector): boolean {
  if (rule.market && rule.market !== market) return false;
  const v = features[rule.feature];
  if (v === undefined || !Number.isFinite(v)) return false;
  if (rule.min != null && v < rule.min) return false;
  if (rule.max != null && v > rule.max) return false;
  return true;
}

export interface RuleEffect {
  /** Total log-odds adjustment to apply. */
  adjustment: number;
  applied: string[];
}

/**
 * Adjustments are summed and then clamped: several overlapping lessons should not be able to
 * override the model outright, only tilt it.
 */
export function applyRules(
  rules: ActiveRule[],
  market: "US" | "UK",
  features: FeatureVector,
  tuning: QuantTuning = DEFAULT_TUNING,
): RuleEffect {
  if (!tuning.rulesEnabled) return { adjustment: 0, applied: [] };
  const applied: string[] = [];
  let total = 0;
  for (const r of rules.slice(0, tuning.maxActiveRules)) {
    if (!matchesRule(r.rule, market, features)) continue;
    total += clamp(r.rule.adjustment, -tuning.maxRuleAdjustment, tuning.maxRuleAdjustment);
    applied.push(r.text);
  }
  return { adjustment: clamp(total, -tuning.maxTotalRuleAdjustment, tuning.maxTotalRuleAdjustment), applied };
}
