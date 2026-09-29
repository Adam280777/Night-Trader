import { z } from "zod";

/**
 * Contracts for everything the decision engine produces and persists.
 * The `Research`, `MarketContext` and `Decision` shapes are kept compatible with rows written by
 * earlier versions so historical runs still render; new fields are additive and nullable.
 */

export const SourceSchema = z.object({ title: z.string(), url: z.string() });
export type Source = z.infer<typeof SourceSchema>;

export const MarketContextSchema = z.object({
  summary: z.string(),
  riskEventsTonight: z.array(z.string()),
  futuresBias: z.enum(["up", "flat", "down", "unknown"]),
  sources: z.array(SourceSchema),
  /** Implied overnight move of the index from futures traded after the cash close, in percent. */
  futuresGapPct: z.number().nullable().default(null),
  vix: z.number().nullable().default(null),
  vixChangePct: z.number().nullable().default(null),
  /** Share (0-1) of tracked sector ETFs trading above their 20-day average. */
  breadth: z.number().nullable().default(null),
  trendRegime: z.enum(["bull", "neutral", "bear", "unknown"]).default("unknown"),
  volRegime: z.enum(["calm", "normal", "stressed", "unknown"]).default("unknown"),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;

export const NewsItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  publisher: z.string(),
  publishedAt: z.string(),
  /** Lexicon sentiment of this single headline, -1..1. */
  score: z.number(),
  tags: z.array(z.string()),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const ResearchSchema = z.object({
  ticker: z.string(),
  summary: z.string(),
  catalysts: z.array(z.string()),
  risks: z.array(z.string()),
  sentiment: z.number(),
  overnightRisk: z.enum(["low", "medium", "high"]),
  earningsOrBinaryEventBeforeNextOpen: z.boolean(),
  sources: z.array(SourceSchema),
  /** Headlines in the last 24h relative to this name's normal rate; 1 = typical. */
  newsBurst: z.number().default(1),
  headlines: z.array(NewsItemSchema).default([]),
});
export type Research = z.infer<typeof ResearchSchema>;

/** One named driver of the score, with its signed contribution in log-odds. */
export const AttributionSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  display: z.string(),
  contribution: z.number(),
});
export type Attribution = z.infer<typeof AttributionSchema>;

export const EvaluationSchema = z.object({
  ticker: z.string(),
  /** Calibrated probability the overnight move clears round-trip costs. */
  probability: z.number(),
  /** Probability from the learned logistic model alone, before blending. */
  modelProbability: z.number(),
  /** Probability from the conditional historical analogues alone. */
  analogueProbability: z.number().nullable(),
  analogueSamples: z.number(),
  expectedMovePct: z.number(),
  /** Expected value after costs, in percent of notional. */
  edgePct: z.number(),
  /** Lower confidence bound on the edge; this is what the engine actually ranks on. */
  riskAdjustedEdgePct: z.number(),
  sigmaPct: z.number(),
  costPct: z.number(),
  kellyFraction: z.number(),
  attributions: z.array(AttributionSchema),
  vetoes: z.array(z.string()),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const DecisionSchema = z.object({
  action: z.enum(["BUY", "NO_TRADE"]),
  ticker: z.string().nullable(),
  confidence: z.number(),
  investPct: z.number(),
  expectedMovePct: z.number(),
  thesis: z.string(),
  risks: z.string(),
  exitPlan: z.string(),
  whyNotOthers: z.array(z.object({ ticker: z.string(), reason: z.string() })),
  lessonsApplied: z.array(z.string()),
  evaluations: z.array(EvaluationSchema).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["thesis_right", "thesis_wrong", "right_for_wrong_reason", "lucky", "unlucky", "inconclusive"]),
  summary: z.string(),
  lessons: z.array(z.object({ text: z.string(), tags: z.array(z.string()) })),
});
export type Review = z.infer<typeof ReviewSchema>;

/**
 * A mined rule. When a candidate matches `feature` inside [min, max] the engine adds
 * `adjustment` to its log-odds, so lessons actually change behaviour instead of being prose.
 */
export const LessonRuleSchema = z.object({
  feature: z.string(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  market: z.enum(["US", "UK"]).nullable(),
  samples: z.number(),
  winRate: z.number(),
  avgReturnPct: z.number(),
  pValue: z.number(),
  adjustment: z.number(),
});
export type LessonRule = z.infer<typeof LessonRuleSchema>;
