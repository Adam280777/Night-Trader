/**
 * The research stage, without a model or a paid search API.
 *
 * It gathers the two things the LLM version was really being paid for - what has been said about
 * the stock recently, and how it behaves from a setup like tonight's - and returns them in the same
 * `Research` shape, with real source URLs taken from the headlines that were actually read.
 */

import { getDailyBars, getFundamentals } from "../market/data";
import { findAnalogues, serializeAnalogue, unconditionalAnalogue, type AnalogueResult, type AnalogueSnapshot } from "./analogues";
import { analyseNews, type NewsAnalysis } from "./news";
import { overnightGaps, type Candidate } from "./screener";
import type { Research, Source } from "./schemas";
import { DEFAULT_TUNING, type QuantTuning } from "./tuning";

/** Enough history for kernel analogues to have something to match against. */

function overnightRiskOf(c: Candidate, news: NewsAnalysis): "low" | "medium" | "high" {
  let score = 0;
  if (news.binaryEventPending) score += 2;
  if (c.signals.earningsWithin2d) score += 2;
  if (news.events.some((e) => e.tag === "distress" || e.tag === "shortseller" || e.tag === "halt")) score += 2;
  if (news.events.some((e) => e.tag === "offering" || e.tag === "legal")) score += 1;
  if (news.burst > 3) score += 1;
  if (c.signals.atrPct > 5) score += 1;
  if (c.signals.gapStdPct > 3) score += 1;
  if (news.sentiment < -0.3) score += 1;
  return score >= 4 ? "high" : score >= 2 ? "medium" : "low";
}

function summarise(c: Candidate, news: NewsAnalysis, analogue: AnalogueResult | null): string {
  const s = c.signals;
  const parts: string[] = [];

  parts.push(
    `${c.name} closed at ${(s.closeLocation * 100).toFixed(0)}% of today's range on ${s.relVolume.toFixed(1)}x normal volume, ${s.ret1dPct >= 0 ? "up" : "down"} ${Math.abs(s.ret1dPct).toFixed(2)}% on the day and ${s.ret5dPct >= 0 ? "up" : "down"} ${Math.abs(s.ret5dPct).toFixed(2)}% over five sessions.`,
  );

  parts.push(
    `Overnight behaviour: a mean close-to-open move of ${s.gapMeanPct >= 0 ? "+" : ""}${s.gapMeanPct.toFixed(2)}% with ${s.gapStdPct.toFixed(2)}% dispersion, positive on ${(s.gapHitRate * 100).toFixed(0)}% of nights (t-stat ${s.gapTStat.toFixed(2)}).`,
  );

  if (analogue && analogue.samples >= 12) {
    parts.push(
      `On ${Math.round(analogue.samples)} comparable past setups the next open averaged ${analogue.meanPct >= 0 ? "+" : ""}${analogue.meanPct.toFixed(2)}%, positive ${(analogue.hitRate * 100).toFixed(0)}% of the time, with a tenth-to-ninetieth percentile range of ${analogue.p10Pct.toFixed(2)}% to ${analogue.p90Pct.toFixed(2)}%.`,
    );
  }

  if (news.items.length === 0) {
    parts.push("No recent headlines were found, so there is no news catalyst either way.");
  } else {
    const tags = [...new Set(news.events.map((e) => e.label))];
    parts.push(
      `${news.items.length} recent headlines score ${news.sentiment >= 0 ? "+" : ""}${news.sentiment.toFixed(2)} on a finance sentiment lexicon, at ${news.burst.toFixed(1)}x this name's normal news rate${tags.length ? `, flagging ${tags.join(", ")}` : ""}.`,
    );
  }

  if (c.signals.earningsWithin2d) parts.push("Earnings fall inside the next two sessions, which makes the overnight distribution two-tailed.");

  return parts.join(" ");
}

export interface CandidateResearch {
  research: Research;
  analogue: AnalogueResult | null;
  analogueSnapshot: AnalogueSnapshot | null;
}

export async function researchCandidate(c: Candidate, tuning: QuantTuning = DEFAULT_TUNING): Promise<CandidateResearch> {
  const [news, fundamentals] = await Promise.all([analyseNews(c.yahoo, tuning), getFundamentals(c.yahoo, c.price)]);

  let analogue: AnalogueResult | null = null;
  try {
    const bars = await getDailyBars(c.yahoo, tuning.analogueBars);
    analogue = findAnalogues(bars, tuning.minAnalogueSamples) ?? unconditionalAnalogue(overnightGaps(bars).map((g) => g.pct));
  } catch {
    /* analogues are an enhancement; the model alone still produces a decision */
  }

  const sources: Source[] = news.items.slice(0, 8).map((n) => ({ title: `${n.title} - ${n.publisher}`, url: n.url }));

  const catalysts = [...news.catalysts];
  if (c.signals.gapTStat > 1.8) catalysts.push(`Statistically positive overnight drift (t-stat ${c.signals.gapTStat.toFixed(2)})`);
  if (c.signals.closeLocation > 0.8 && c.signals.relVolume > 1.3) catalysts.push("Closed near the high of the day on heavy volume");
  if (analogue && analogue.samples >= 12 && analogue.meanPct > 0.2) {
    catalysts.push(`Comparable setups averaged +${analogue.meanPct.toFixed(2)}% overnight`);
  }

  const risks = [...news.risks];
  if (fundamentals) {
    const f = fundamentals;
    if (f.netUpgrades14d != null && f.netUpgrades14d >= 2) catalysts.push(`${f.netUpgrades14d} net analyst upgrades in the last two weeks`);
    if (f.netUpgrades14d != null && f.netUpgrades14d <= -2) risks.push(`${-f.netUpgrades14d} net analyst downgrades in the last two weeks`);
    if (f.epsSurprisePct != null && f.epsSurprisePct > 5) catalysts.push(`Beat earnings estimates by ${f.epsSurprisePct.toFixed(0)}% on average over four reports`);
    if (f.epsSurprisePct != null && f.epsSurprisePct < -5) risks.push(`Missed earnings estimates by ${(-f.epsSurprisePct).toFixed(0)}% on average over four reports`);
    if (f.shortPctFloat != null && f.shortPctFloat > 0.15) risks.push(`High short interest: ${(f.shortPctFloat * 100).toFixed(0)}% of the float is sold short`);
  }
  if (c.signals.earningsWithin2d) risks.push("Earnings due within two days");
  if (news.binaryEventPending) risks.push("A binary event may resolve before the next open");
  if (c.signals.gapStdPct > 2.5) risks.push(`Wide overnight dispersion (${c.signals.gapStdPct.toFixed(2)}%)`);
  if (analogue && analogue.p10Pct < -3) risks.push(`A bad night for this setup has historically meant ${analogue.p10Pct.toFixed(2)}%`);

  const research: Research = {
    ticker: c.ticker,
    summary: summarise(c, news, analogue),
    catalysts: catalysts.slice(0, 6),
    risks: risks.slice(0, 6),
    sentiment: news.sentiment,
    overnightRisk: overnightRiskOf(c, news),
    earningsOrBinaryEventBeforeNextOpen: news.binaryEventPending || c.signals.earningsWithin2d,
    sources,
    newsBurst: news.burst,
    headlines: news.items.slice(0, 12),
    fundamentals,
  };

  return { research, analogue, analogueSnapshot: analogue ? serializeAnalogue(analogue) : null };
}
