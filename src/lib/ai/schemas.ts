import { z } from "zod";

// NB: OpenAI structured outputs require every field present; "optional" = nullable.

export const SourceSchema = z.object({ title: z.string(), url: z.string() });

export const MarketContextSchema = z.object({
  summary: z.string().describe("2-4 sentences on today's market mood and what could move stocks overnight"),
  riskEventsTonight: z.array(z.string()).describe("Scheduled events between now and next open (data releases, central banks, earnings of megacaps)"),
  futuresBias: z.enum(["up", "flat", "down", "unknown"]),
  sources: z.array(SourceSchema),
});
export type MarketContext = z.infer<typeof MarketContextSchema>;

export const ResearchSchema = z.object({
  ticker: z.string(),
  summary: z.string().describe("What is driving this stock right now, in 2-4 sentences"),
  catalysts: z.array(z.string()).describe("Concrete reasons it could rise overnight/at the next open"),
  risks: z.array(z.string()).describe("Concrete reasons it could gap down"),
  sentiment: z.number().describe("-1 very bearish to +1 very bullish, based on recent news"),
  overnightRisk: z.enum(["low", "medium", "high"]),
  earningsOrBinaryEventBeforeNextOpen: z.boolean(),
  sources: z.array(SourceSchema).describe("Pages actually used, with URLs"),
});
export type Research = z.infer<typeof ResearchSchema>;

export const DecisionSchema = z.object({
  action: z.enum(["BUY", "NO_TRADE"]),
  ticker: z.string().nullable().describe("Exact ticker from the candidate list; null if NO_TRADE"),
  confidence: z.number().describe("0-1 probability that the overnight return is positive AND exceeds costs"),
  investPct: z.number().describe("Fraction (0-1) of available cash to invest; 0 if NO_TRADE"),
  expectedMovePct: z.number().describe("Expected overnight move in percent (close to next open)"),
  thesis: z.string().describe("Why this stock, why tonight, 3-6 sentences"),
  risks: z.string().describe("What would make this wrong"),
  exitPlan: z.string().describe("How and when to exit; default is sell at next open"),
  whyNotOthers: z.array(z.object({ ticker: z.string(), reason: z.string() })),
  lessonsApplied: z.array(z.string()).describe("Which past lessons/stats influenced this decision"),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["thesis_right", "thesis_wrong", "right_for_wrong_reason", "lucky", "unlucky", "inconclusive"]),
  summary: z.string().describe("2-3 sentences comparing the thesis to what actually happened"),
  lessons: z
    .array(z.object({ text: z.string().describe("A specific, reusable rule of thumb"), tags: z.array(z.string()) }))
    .describe("0-3 lessons. Only include lessons that generalise; return [] if the outcome was just noise."),
});
export type Review = z.infer<typeof ReviewSchema>;
