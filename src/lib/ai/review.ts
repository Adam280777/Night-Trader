import { structured } from "./llm";
import { ReviewSchema, type Review } from "./schemas";

const SYSTEM = `You review completed overnight trades for a trading system that learns from its own results.
Be honest and skeptical: one overnight move is mostly noise, so do NOT over-fit. Only write a lesson when
it is a specific, reusable rule supported by the evidence (for example about a type of catalyst, market,
volatility, time-of-day, or an ignored risk). Return an empty lessons array when the result was just noise.
Never repeat a lesson that is already in the existing list; refine it instead if needed.`;

export interface ReviewInput {
  ticker: string;
  market: string;
  thesis: string;
  risks: string;
  confidence: number;
  expectedMovePct: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPct: number | null;
  shortlistOutcomes: { ticker: string; overnightReturnPct: number | null; picked: boolean }[];
  existingLessons: string[];
}

export async function reviewTrade(i: ReviewInput): Promise<Review> {
  const others = i.shortlistOutcomes
    .filter((o) => !o.picked && o.overnightReturnPct != null)
    .map((o) => `${o.ticker} ${o.overnightReturnPct!.toFixed(2)}%`)
    .join(", ");
  const { data } = await structured(ReviewSchema, {
    name: "trade_review",
    instructions: SYSTEM,
    input: `Trade: ${i.ticker} (${i.market}). Entry ${i.entryPrice}, exit ${i.exitPrice}, result ${i.pnlPct?.toFixed(2)}%.
Predicted: confidence ${(i.confidence * 100).toFixed(0)}%, expected move ${i.expectedMovePct.toFixed(2)}%.
Thesis: ${i.thesis}
Risks you noted: ${i.risks}
Other shortlisted stocks' actual overnight returns: ${others || "n/a"}
Existing lessons:\n${i.existingLessons.map((l) => `- ${l}`).join("\n") || "(none)"}`,
    effort: "medium",
  });
  return data;
}
