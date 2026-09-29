/**
 * Every tunable number in the quantitative engine, defined once.
 *
 * The schema is the source of truth for validation, the defaults are the shipped behaviour, and
 * the metadata drives the Settings UI, so a parameter can never exist in the engine without being
 * adjustable, or appear in the UI without being real. Each entry carries the plain-English
 * consequence of moving it, because a number with no explanation is a number nobody should touch.
 */

import { z } from "zod";

export const QuantTuningSchema = z.object({
  // --- Decision engine -------------------------------------------------------------------------
  kellyFraction: z.number().min(0.01).max(1).default(0.25),
  uncertaintyPenalty: z.number().min(0).max(4).default(1),
  analoguePriorWeight: z.number().min(1).max(300).default(35),
  maxAnalogueWeight: z.number().min(0).max(0.95).default(0.6),
  minAnalogueSamples: z.number().int().min(4).max(200).default(12),
  maxProbability: z.number().min(0.6).max(0.99).default(0.95),
  minKellyFraction: z.number().min(0).max(0.5).default(0.02),

  // --- Costs -----------------------------------------------------------------------------------
  ukStampDutyPct: z.number().min(0).max(2).default(0.5),
  fxFeePctPerSide: z.number().min(0).max(1).default(0.15),
  openingAuctionSlippagePct: z.number().min(0).max(1).default(0.05),
  extraCostBufferPct: z.number().min(0).max(2).default(0),

  // --- Screening -------------------------------------------------------------------------------
  shortlistSize: z.number().int().min(3).max(20).default(8),
  candidatePoolSize: z.number().int().min(10).max(150).default(60),
  usMinDollarVolume: z.number().min(1e5).max(1e9).default(20_000_000),
  ukMinDollarVolume: z.number().min(1e5).max(1e9).default(5_000_000),
  minMarketCap: z.number().min(0).max(1e12).default(1e9),
  historyBars: z.number().int().min(120).max(500).default(260),
  analogueBars: z.number().int().min(250).max(2000).default(750),

  // --- Vetoes ----------------------------------------------------------------------------------
  vetoEarnings: z.boolean().default(true),
  vetoBinaryEvent: z.boolean().default(true),
  vetoHighNewsRisk: z.boolean().default(true),
  vetoStressedVol: z.boolean().default(true),
  minTurnoverUsd: z.number().min(0).max(1e9).default(2_000_000),

  // --- Learning --------------------------------------------------------------------------------
  learningRate: z.number().min(0.001).max(1).default(0.08),
  ridge: z.number().min(0).max(1).default(0.02),
  trainingPasses: z.number().int().min(1).max(10).default(2),
  rulesEnabled: z.boolean().default(true),
  minRuleSamples: z.number().int().min(10).max(500).default(30),
  maxRulePValue: z.number().min(0.001).max(0.5).default(0.05),
  maxActiveRules: z.number().int().min(0).max(50).default(12),
  maxRuleAdjustment: z.number().min(0.05).max(3).default(0.7),
  maxTotalRuleAdjustment: z.number().min(0.1).max(5).default(1.2),

  // --- News ------------------------------------------------------------------------------------
  newsHalfLifeHours: z.number().min(1).max(240).default(36),
  newsMaxHeadlines: z.number().int().min(5).max(50).default(20),
  newsSentimentWeight: z.number().min(0).max(3).default(1),

  // --- Continuous study ------------------------------------------------------------------------
  continuousResearch: z.boolean().default(true),
  studyIntervalMinutes: z.number().int().min(1).max(240).default(10),
  studyBatchSize: z.number().int().min(5).max(300).default(60),
  studyResearchCount: z.number().int().min(0).max(40).default(8),
  knowledgeTtlHours: z.number().min(1).max(168).default(12),
  knowledgeRetentionDays: z.number().int().min(1).max(365).default(30),
  knowledgeBoostCount: z.number().int().min(0).max(10).default(3),
  minObservationsToTrust: z.number().int().min(1).max(50).default(3),
});

export type QuantTuning = z.infer<typeof QuantTuningSchema>;
export const DEFAULT_TUNING: QuantTuning = QuantTuningSchema.parse({});

export const TUNING_GROUPS = ["engine", "costs", "screening", "study", "vetoes", "learning", "news"] as const;
export type TuningGroup = (typeof TUNING_GROUPS)[number];

export const GROUP_META: Record<TuningGroup, { title: string; blurb: string }> = {
  engine: {
    title: "Decision engine",
    blurb: "How a probability becomes a position. These control how boldly the model acts on what it believes.",
  },
  costs: {
    title: "Costs and the hurdle",
    blurb: "What a round trip is assumed to cost. The expected move must clear this before anything is bought, so raising these makes the engine pickier.",
  },
  screening: {
    title: "Screening and history",
    blurb: "How wide the net is cast each night and how much price history each name is judged against.",
  },
  study: {
    title: "Continuous study",
    blurb:
      "The model researches all day rather than only before the close, building a knowledge base it can draw on the moment a decision is due. These control how hard it studies and how long what it learned stays fresh.",
  },
  vetoes: {
    title: "Hard vetoes",
    blurb: "Conditions that disqualify a candidate outright, no matter how good its numbers look.",
  },
  learning: {
    title: "Learning",
    blurb: "How quickly the model updates from outcomes, and how much evidence a pattern needs before it becomes a rule.",
  },
  news: {
    title: "Headlines",
    blurb: "How headline sentiment is gathered and how fast it is treated as stale.",
  },
};

export interface TuningParam {
  key: keyof QuantTuning;
  group: TuningGroup;
  label: string;
  hint: string;
  kind: "number" | "boolean";
  min?: number;
  max?: number;
  step?: number;
  /** Stored value is multiplied by this for display (e.g. 100 to show a fraction as a percent). */
  scale?: number;
  unit?: string;
}

export const TUNING_PARAMS: TuningParam[] = [
  // Engine
  {
    key: "kellyFraction",
    group: "engine",
    label: "Kelly fraction",
    hint: "Share of the mathematically optimal stake actually taken. Full Kelly (100%) maximises long-run growth but swings violently and assumes the edge is known exactly; a quarter is the usual compromise. Raising this makes every position bigger.",
    kind: "number",
    min: 1,
    max: 100,
    step: 5,
    scale: 100,
    unit: "%",
  },
  {
    key: "uncertaintyPenalty",
    group: "engine",
    label: "Uncertainty charge",
    hint: "How many standard errors of estimation error are subtracted from the edge before ranking. Higher means the engine demands more proof and trades less often; zero means it takes its own estimates at face value.",
    kind: "number",
    min: 0,
    max: 4,
    step: 0.1,
    unit: "σ",
  },
  {
    key: "analoguePriorWeight",
    group: "engine",
    label: "Analogue trust threshold",
    hint: "How many matching historical sessions it takes before the stock's own history is trusted as much as the cross-sectional model. Lower means name-specific history dominates sooner.",
    kind: "number",
    min: 1,
    max: 300,
    step: 5,
    unit: "samples",
  },
  {
    key: "maxAnalogueWeight",
    group: "engine",
    label: "Max analogue weight",
    hint: "Ceiling on how much of the final probability can come from historical analogues, no matter how many there are. Keeps one stock's quirks from overruling everything learned across all names.",
    kind: "number",
    min: 0,
    max: 95,
    step: 5,
    scale: 100,
    unit: "%",
  },
  {
    key: "minAnalogueSamples",
    group: "engine",
    label: "Minimum analogues",
    hint: "Fewer matching sessions than this and the analogue view is discarded entirely rather than used thinly.",
    kind: "number",
    min: 4,
    max: 200,
    step: 1,
    unit: "sessions",
  },
  {
    key: "maxProbability",
    group: "engine",
    label: "Probability ceiling",
    hint: "No candidate is ever allowed to look more certain than this. Overnight gaps always carry irreducible risk, and a model that says 99% is usually wrong about its own confidence.",
    kind: "number",
    min: 60,
    max: 99,
    step: 1,
    scale: 100,
    unit: "%",
  },
  {
    key: "minKellyFraction",
    group: "engine",
    label: "Minimum worthwhile stake",
    hint: "If the optimal stake falls below this share of free cash the trade is skipped, because a tiny position cannot repay the spread and the attention.",
    kind: "number",
    min: 0,
    max: 50,
    step: 0.5,
    scale: 100,
    unit: "%",
  },

  // Costs
  {
    key: "ukStampDutyPct",
    group: "costs",
    label: "UK stamp duty",
    hint: "Charged on UK share purchases. This is why UK trades need a visibly better setup than US ones to be worth taking.",
    kind: "number",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "%",
  },
  {
    key: "fxFeePctPerSide",
    group: "costs",
    label: "FX fee per side",
    hint: "Trading 212's currency conversion charge, applied on both the buy and the sell of a non-GBP trade.",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    unit: "%",
  },
  {
    key: "openingAuctionSlippagePct",
    group: "costs",
    label: "Opening auction slippage",
    hint: "Extra return demanded because selling into the open crosses a wider spread than the quoted one. Raise it if fills at the open keep coming in worse than expected.",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    unit: "%",
  },
  {
    key: "extraCostBufferPct",
    group: "costs",
    label: "Extra safety buffer",
    hint: "A flat amount added to every cost estimate. The simplest single dial for making the engine more conservative across the board.",
    kind: "number",
    min: 0,
    max: 2,
    step: 0.05,
    unit: "%",
  },

  // Screening
  {
    key: "shortlistSize",
    group: "screening",
    label: "Shortlist size",
    hint: "How many names get full research and evaluation each night. More means better odds of finding an edge and more labelled training data per day, but a slower run.",
    kind: "number",
    min: 3,
    max: 20,
    step: 1,
    unit: "names",
  },
  {
    key: "candidatePoolSize",
    group: "screening",
    label: "Deep-scan pool",
    hint: "How many of the most liquid names get full price-history signals computed before the shortlist is cut. Larger is more thorough but costs run time.",
    kind: "number",
    min: 10,
    max: 150,
    step: 5,
    unit: "names",
  },
  {
    key: "usMinDollarVolume",
    group: "screening",
    label: "US minimum turnover",
    hint: "Daily traded value a US name must exceed to be considered at all. Thin names cannot be exited into the open without slippage.",
    kind: "number",
    min: 0.1,
    max: 1000,
    step: 1,
    scale: 1e-6,
    unit: "$M/day",
  },
  {
    key: "ukMinDollarVolume",
    group: "screening",
    label: "UK minimum turnover",
    hint: "The same floor for UK names, normally set lower because the market is smaller.",
    kind: "number",
    min: 0.1,
    max: 1000,
    step: 1,
    scale: 1e-6,
    unit: "$M/day",
  },
  {
    key: "minMarketCap",
    group: "screening",
    label: "Minimum market cap",
    hint: "Excludes small companies, whose overnight gaps are driven more by single headlines than by the patterns this model learns.",
    kind: "number",
    min: 0,
    max: 1_000_000,
    step: 100,
    scale: 1e-6,
    unit: "$M",
  },
  {
    key: "historyBars",
    group: "screening",
    label: "Screening history",
    hint: "Daily bars used to compute each name's signals. Longer is more stable but slower to notice that a stock's behaviour has changed.",
    kind: "number",
    min: 120,
    max: 500,
    step: 10,
    unit: "days",
  },
  {
    key: "analogueBars",
    group: "screening",
    label: "Analogue history",
    hint: "Daily bars searched for sessions resembling tonight's setup. More history finds more matches but reaches back into older market regimes.",
    kind: "number",
    min: 250,
    max: 2000,
    step: 50,
    unit: "days",
  },

  // Vetoes
  {
    key: "vetoEarnings",
    group: "vetoes",
    label: "Veto earnings within two days",
    hint: "Earnings turn an overnight hold into a coin flip on a single announcement. Leave on unless you specifically want that exposure.",
    kind: "boolean",
  },
  {
    key: "vetoBinaryEvent",
    group: "vetoes",
    label: "Veto pending binary events",
    hint: "Blocks names whose headlines point to a yes/no outcome landing before the next open, such as a trial result or a regulatory decision.",
    kind: "boolean",
  },
  {
    key: "vetoHighNewsRisk",
    group: "vetoes",
    label: "Veto high headline risk",
    hint: "Blocks names where recent coverage is heavily negative or unusually intense.",
    kind: "boolean",
  },
  {
    key: "vetoStressedVol",
    group: "vetoes",
    label: "Veto in stressed markets",
    hint: "Sits out entirely when the volatility regime reads as stressed, where overnight gaps stop following their usual distribution.",
    kind: "boolean",
  },
  {
    key: "minTurnoverUsd",
    group: "vetoes",
    label: "Veto below turnover",
    hint: "A final liquidity backstop applied at decision time, after research, independent of the screening floor.",
    kind: "number",
    min: 0,
    max: 1000,
    step: 0.5,
    scale: 1e-6,
    unit: "$M/day",
  },

  // Learning
  {
    key: "learningRate",
    group: "learning",
    label: "Learning rate",
    hint: "How far each outcome moves the model's weights. Higher adapts faster to a changing market but overreacts to noise and to lucky nights.",
    kind: "number",
    min: 0.001,
    max: 1,
    step: 0.005,
  },
  {
    key: "ridge",
    group: "learning",
    label: "Pull toward priors",
    hint: "How strongly weights are pulled back to their hand-set starting values on every update. Higher keeps the model close to sensible defaults; zero lets the data say anything it likes.",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.005,
  },
  {
    key: "trainingPasses",
    group: "learning",
    label: "Training passes",
    hint: "How many times each batch of new outcomes is learned from. More extracts additional signal from scarce data at the cost of overfitting it.",
    kind: "number",
    min: 1,
    max: 10,
    step: 1,
    unit: "passes",
  },
  {
    key: "rulesEnabled",
    group: "learning",
    label: "Apply mined rules",
    hint: "Whether statistically significant patterns found in past outcomes are allowed to adjust tonight's probabilities. Turn off to run on the model alone.",
    kind: "boolean",
  },
  {
    key: "minRuleSamples",
    group: "learning",
    label: "Minimum rule evidence",
    hint: "How many past candidates must fall inside a pattern before it can become a rule. Lower finds rules sooner and finds more false ones.",
    kind: "number",
    min: 10,
    max: 500,
    step: 5,
    unit: "samples",
  },
  {
    key: "maxRulePValue",
    group: "learning",
    label: "Significance threshold",
    hint: "The p-value a pattern must beat. 0.05 means roughly a one-in-twenty chance the pattern is pure luck; tighten it to be stricter.",
    kind: "number",
    min: 0.001,
    max: 0.5,
    step: 0.005,
  },
  {
    key: "maxActiveRules",
    group: "learning",
    label: "Maximum active rules",
    hint: "Cap on how many mined rules can be live at once. Set to zero to keep mining and reporting them without letting them affect decisions.",
    kind: "number",
    min: 0,
    max: 50,
    step: 1,
    unit: "rules",
  },
  {
    key: "maxRuleAdjustment",
    group: "learning",
    label: "Max single rule effect",
    hint: "Largest log-odds nudge any one rule may apply. Keeps a single striking pattern from dominating the decision.",
    kind: "number",
    min: 0.05,
    max: 3,
    step: 0.05,
  },
  {
    key: "maxTotalRuleAdjustment",
    group: "learning",
    label: "Max combined rule effect",
    hint: "Ceiling on all rules added together, so a pile of agreeing rules cannot overwhelm the model itself.",
    kind: "number",
    min: 0.1,
    max: 5,
    step: 0.1,
  },

  // News
  {
    key: "newsHalfLifeHours",
    group: "news",
    label: "Headline half-life",
    hint: "How long it takes for a headline to count half as much. Shorter means only the very latest news matters to tonight's open.",
    kind: "number",
    min: 1,
    max: 240,
    step: 1,
    unit: "hours",
  },
  {
    key: "newsMaxHeadlines",
    group: "news",
    label: "Headlines per name",
    hint: "How many recent headlines are fetched and scored for each candidate.",
    kind: "number",
    min: 5,
    max: 50,
    step: 1,
    unit: "items",
  },
  {
    key: "newsSentimentWeight",
    group: "news",
    label: "Sentiment influence",
    hint: "Multiplier on how much headline sentiment moves the final probability. Zero ignores the news entirely and decides on price behaviour alone.",
    kind: "number",
    min: 0,
    max: 3,
    step: 0.1,
    unit: "×",
  },

  // Continuous study
  {
    key: "continuousResearch",
    group: "study",
    label: "Study all day",
    hint: "When on, the model works through the universe continuously, scoring names and reading their headlines long before a decision is due, and stores what it finds. When off it only researches inside the pre-close window and starts every night from nothing.",
    kind: "boolean",
  },
  {
    key: "studyIntervalMinutes",
    group: "study",
    label: "Study every",
    hint: "How often a study round runs. Study only ever uses time left over after live trading work, so shortening this makes it study more often but never delays a trade.",
    kind: "number",
    min: 1,
    max: 240,
    step: 1,
    unit: "min",
  },
  {
    key: "studyBatchSize",
    group: "study",
    label: "Names scanned per round",
    hint: "How many symbols are pulled from the rotation and scored each round. Larger rounds cover the universe faster but each round takes longer.",
    kind: "number",
    min: 5,
    max: 300,
    step: 5,
    unit: "symbols",
  },
  {
    key: "studyResearchCount",
    group: "study",
    label: "Researched per round",
    hint: "How many of each round's best-scoring names also get full headline and analogue research. This is the slow part; zero means the base stores price signals only.",
    kind: "number",
    min: 0,
    max: 40,
    step: 1,
    unit: "symbols",
  },
  {
    key: "knowledgeTtlHours",
    group: "study",
    label: "Research stays fresh for",
    hint: "Stored research older than this is refetched rather than reused. Longer means less work and more reuse, at the cost of acting on staler headlines.",
    kind: "number",
    min: 1,
    max: 168,
    step: 1,
    unit: "hours",
  },
  {
    key: "knowledgeRetentionDays",
    group: "study",
    label: "Forget names after",
    hint: "A symbol that has not been seen in the rotation for this long is dropped from the knowledge base, so delistings and stale names do not accumulate.",
    kind: "number",
    min: 1,
    max: 365,
    step: 1,
    unit: "days",
  },
  {
    key: "knowledgeBoostCount",
    group: "study",
    label: "Extra slots from the base",
    hint: "Names the knowledge base rates highly are added to tonight's shortlist even if the live screen ranked them just outside it. Zero ignores the base when shortlisting.",
    kind: "number",
    min: 0,
    max: 10,
    step: 1,
    unit: "slots",
  },
  {
    key: "minObservationsToTrust",
    group: "study",
    label: "Sightings before trusting a name",
    hint: "How many separate study rounds a symbol must have appeared in before the base is willing to promote it. Higher means only names with a consistent record get the benefit of the doubt.",
    kind: "number",
    min: 1,
    max: 50,
    step: 1,
    unit: "rounds",
  },
];

export const PARAMS_BY_GROUP = (group: TuningGroup) => TUNING_PARAMS.filter((p) => p.group === group);

/** Named starting points. Anything not listed keeps its default. */
export const TUNING_PRESETS: Record<string, { label: string; blurb: string; values: Partial<QuantTuning> }> = {
  cautious: {
    label: "Cautious",
    blurb: "Trades rarely, sizes small, demands strong proof. Expect many no-trade nights.",
    values: {
      kellyFraction: 0.15,
      uncertaintyPenalty: 1.5,
      extraCostBufferPct: 0.1,
      minKellyFraction: 0.04,
      maxProbability: 0.9,
      vetoEarnings: true,
      vetoBinaryEvent: true,
      vetoHighNewsRisk: true,
      vetoStressedVol: true,
      minRuleSamples: 50,
      maxRulePValue: 0.02,
      learningRate: 0.05,
    },
  },
  balanced: {
    label: "Balanced",
    blurb: "The shipped defaults: quarter-Kelly sizing with a one-sigma uncertainty charge.",
    values: DEFAULT_TUNING,
  },
  aggressive: {
    label: "Aggressive",
    blurb: "Trades more often and sizes larger on thinner evidence. Higher variance, and more training data per week.",
    values: {
      kellyFraction: 0.4,
      uncertaintyPenalty: 0.5,
      extraCostBufferPct: 0,
      minKellyFraction: 0.01,
      maxProbability: 0.97,
      analoguePriorWeight: 20,
      vetoHighNewsRisk: false,
      vetoStressedVol: false,
      minRuleSamples: 20,
      maxRulePValue: 0.1,
      learningRate: 0.12,
      shortlistSize: 12,
    },
  },
};

/** Formats a raw stored value compactly, for summaries outside the settings inputs. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}
