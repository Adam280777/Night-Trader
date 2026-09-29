/**
 * Turns the numeric decision into prose.
 *
 * The narrative is generated from the same attributions the model actually used, so what the user
 * reads is a faithful description of the arithmetic rather than a plausible-sounding story written
 * next to it. Every claim here is traceable to a feature value.
 */

import { FEATURE_BY_KEY, type FeatureContext } from "./features";
import type { Attribution, Evaluation } from "./schemas";

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

export function buildAttributions(
  contributions: { key: string; contribution: number }[],
  ctx: FeatureContext,
  limit = 6,
): Attribution[] {
  return contributions
    .filter((c) => Math.abs(c.contribution) > 0.01)
    .slice(0, limit)
    .map((c) => {
      const def = FEATURE_BY_KEY.get(c.key);
      return {
        key: c.key,
        label: def?.label ?? c.key,
        value: def?.extract(ctx) ?? 0,
        display: def?.display(ctx) ?? c.key,
        contribution: c.contribution,
      };
    });
}

const joinSentences = (parts: string[]) => parts.filter(Boolean).join(" ");

export function buildThesis(e: Evaluation, ctx: FeatureContext, name: string): string {
  const supports = e.attributions.filter((a) => a.contribution > 0).slice(0, 3);
  const against = e.attributions.filter((a) => a.contribution < 0).slice(0, 2);

  const lead = `${name} (${e.ticker}) scores best of tonight's shortlist: a ${(e.probability * 100).toFixed(0)}% calibrated chance of clearing the ${e.costPct.toFixed(2)}% round-trip cost, for an expected overnight move of ${pct(e.expectedMovePct)} and an edge of ${pct(e.edgePct)} after costs.`;

  const why = supports.length
    ? `What drives that: ${supports.map((a) => `${a.label.toLowerCase()} (${a.display})`).join("; ")}.`
    : "";

  const analogue =
    e.analogueSamples >= 12 && e.analogueProbability != null
      ? `Across ${Math.round(e.analogueSamples)} historical sessions where this stock's setup looked like tonight's, ${(e.analogueProbability * 100).toFixed(0)}% cleared the same cost hurdle.`
      : "There were too few comparable historical sessions to lean on, so the score rests on the model and the current tape.";

  const market = ctx.context?.summary ? `Market backdrop: ${ctx.context.summary}` : "";

  const caution = against.length ? `Working against it: ${against.map((a) => a.display).join("; ")}.` : "";

  const sizing = `Sizing is ${(e.kellyFraction * 100).toFixed(0)}% of free cash, from a quarter-Kelly stake on an edge of ${pct(e.edgePct)} against ${e.sigmaPct.toFixed(2)}% expected dispersion, before the hard limits are applied.`;

  return joinSentences([lead, why, analogue, caution, market, sizing]);
}

export function buildRisks(e: Evaluation, ctx: FeatureContext): string {
  const parts: string[] = [];
  const negatives = e.attributions.filter((a) => a.contribution < 0);
  if (negatives.length) parts.push(`Model negatives: ${negatives.map((a) => a.display).join("; ")}.`);
  if (ctx.research?.risks?.length) parts.push(`Recent negative headlines: ${ctx.research.risks.slice(0, 3).join("; ")}.`);
  if (ctx.research?.earningsOrBinaryEventBeforeNextOpen) parts.push("A binary event may resolve before the next open, which makes the gap distribution two-tailed rather than drifting.");
  if (ctx.context?.riskEventsTonight?.length) parts.push(`Scheduled overnight events: ${ctx.context.riskEventsTonight.join("; ")}.`);
  parts.push(
    `Downside is not bounded by the thesis: a tenth-percentile night for this setup was about ${e.sigmaPct.toFixed(2)}% of dispersion, and gaps cannot be stopped out because there is no trading between the close and the open.`,
  );
  if (e.vetoes.length) parts.push(`Flags raised: ${e.vetoes.join("; ")}.`);
  return parts.join(" ");
}

export function buildExitPlan(market: "US" | "UK"): string {
  return `Sell the whole position with a market order in the first minutes of the next ${market} regular session. The position is never carried through a second night, and the scheduler exits regardless of whether the trade is up or down.`;
}

/** Explains a NO_TRADE in terms of what the best candidate was missing. */
export function buildNoTradeThesis(best: Evaluation | null, reason: string, count: number): string {
  if (!best) return `No candidate could be evaluated tonight, so no trade. ${reason}`;
  return joinSentences([
    `No trade tonight. Of ${count} shortlisted names the strongest was ${best.ticker}, at a ${(best.probability * 100).toFixed(0)}% chance of clearing its ${best.costPct.toFixed(2)}% cost hurdle and an expected edge of ${pct(best.edgePct)} (${pct(best.riskAdjustedEdgePct)} once estimation uncertainty is charged for).`,
    reason,
    "Sitting out costs nothing, whereas a negative-expectancy overnight position costs the spread plus the fees every time.",
  ]);
}

export const whyNotReason = (e: Evaluation) =>
  e.vetoes.length
    ? e.vetoes.join("; ")
    : `${(e.probability * 100).toFixed(0)}% to clear costs, edge ${pct(e.edgePct)} (${pct(e.riskAdjustedEdgePct)} risk-adjusted)`;
