import { structured } from "./llm";
import { MarketContextSchema, ResearchSchema, type MarketContext, type Research } from "./schemas";
import type { Candidate } from "./screener";

const SYSTEM = `You are a meticulous equity research analyst supporting an overnight trading strategy:
buy shortly before the market close, sell at the next open. Only the move from today's close to
tomorrow's open matters. Use web search to find CURRENT information (today's news, filings, analyst
actions, guidance, sector/macro news). Prefer primary and reputable sources. Never invent facts or
URLs; if you cannot verify something, say so. Be concise and concrete.`;

export async function researchMarket(market: "US" | "UK"): Promise<{ data: MarketContext; citations: { title: string; url: string }[] }> {
  const label = market === "US" ? "US equity markets (NYSE/Nasdaq)" : "UK equity markets (London Stock Exchange)";
  return structured(MarketContextSchema, {
    name: "market_context",
    instructions: SYSTEM,
    input: `Today is ${new Date().toISOString().slice(0, 10)}. Summarise the mood of ${label} today and what could move stocks between now and tomorrow's open: scheduled data releases, central bank speakers, major earnings after the close, index futures direction, geopolitical developments.`,
    webSearch: true,
    effort: "low",
  });
}

export async function researchCandidate(c: Candidate, market: "US" | "UK"): Promise<{ research: Research; citations: { title: string; url: string }[] }> {
  const s = c.signals;
  const { data, citations } = await structured(ResearchSchema, {
    name: "candidate_research",
    instructions: SYSTEM,
    input: `Research ${c.name} (${c.ticker}, ${market} market). Today is ${new Date().toISOString().slice(0, 10)}.
Quant context (from price data, may be stale): 1d ${s.ret1dPct.toFixed(1)}%, 5d ${s.ret5dPct.toFixed(1)}%, 20d ${s.ret20dPct.toFixed(1)}%, relative volume ${s.relVolume.toFixed(1)}x, closed at ${(s.closeLocation * 100).toFixed(0)}% of today's range.
Find: news today and in the last few days; any earnings/guidance/regulatory or other binary event before tomorrow's open (set earningsOrBinaryEventBeforeNextOpen); analyst rating changes; sector or macro drivers; reasons for a gap up and reasons for a gap down. Set "ticker" to exactly "${c.ticker}".`,
    webSearch: true,
    effort: "low",
  });
  return { research: { ...data, ticker: c.ticker }, citations };
}

/** Research with limited concurrency; failed candidates are dropped, not fatal. */
export async function researchAll(cands: Candidate[], market: "US" | "UK", concurrency = 3) {
  const out = new Map<string, { research: Research; citations: { title: string; url: string }[] }>();
  const errors: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cands.length) }, async () => {
      while (next < cands.length) {
        const c = cands[next++];
        try {
          out.set(c.ticker, await researchCandidate(c, market));
        } catch (err) {
          errors.push(`${c.ticker}: ${String(err).slice(0, 200)}`);
        }
      }
    }),
  );
  return { results: out, errors };
}
