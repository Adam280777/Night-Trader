/**
 * Headline sentiment and event detection with no paid API.
 *
 * Source: Yahoo Finance's public news feed (via the already-bundled yahoo-finance2 client, with the
 * keyless RSS endpoint as a fallback). Headlines are scored with a finance-specific lexicon in the
 * spirit of Loughran-McDonald: general-purpose sentiment lists mislabel words like "liability",
 * "crude" or "tender" that are neutral or positive in a filings/markets context.
 */

import YahooFinance from "yahoo-finance2";
import { clamp, mean } from "./stats";
import type { NewsItem } from "./schemas";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const OPTS = { validateResult: false } as const;

/** Multi-word phrases are matched before single tokens so "beats expectations" wins over "beats". */
const PHRASES: [string, number][] = [
  ["beats expectations", 0.9],
  ["beat expectations", 0.9],
  ["tops estimates", 0.9],
  ["above expectations", 0.8],
  ["raises guidance", 1.0],
  ["raised guidance", 1.0],
  ["lifts outlook", 0.9],
  ["raises outlook", 0.9],
  ["record revenue", 0.8],
  ["record profit", 0.8],
  ["record high", 0.6],
  ["all-time high", 0.6],
  ["better than expected", 0.8],
  ["stronger than expected", 0.8],
  ["price target raised", 0.7],
  ["raises price target", 0.7],
  ["boosts price target", 0.7],
  ["upgraded to buy", 0.9],
  ["initiated at buy", 0.6],
  ["share buyback", 0.6],
  ["buyback program", 0.6],
  ["special dividend", 0.5],
  ["dividend increase", 0.5],
  ["takeover approach", 0.9],
  ["takeover bid", 1.0],
  ["acquisition offer", 0.9],
  ["to be acquired", 1.0],
  ["merger agreement", 0.7],
  ["strategic review", 0.3],
  ["fda approval", 1.0],
  ["approved by the fda", 1.0],
  ["positive results", 0.8],
  ["met primary endpoint", 0.9],
  ["contract win", 0.7],
  ["wins contract", 0.7],
  ["new order", 0.4],

  ["misses expectations", -0.9],
  ["missed expectations", -0.9],
  ["misses estimates", -0.9],
  ["below expectations", -0.8],
  ["cuts guidance", -1.0],
  ["cut guidance", -1.0],
  ["lowers guidance", -1.0],
  ["lowers outlook", -0.9],
  ["slashes outlook", -1.0],
  ["profit warning", -1.0],
  ["worse than expected", -0.8],
  ["weaker than expected", -0.8],
  ["price target cut", -0.7],
  ["cuts price target", -0.7],
  ["lowers price target", -0.7],
  ["downgraded to sell", -1.0],
  ["downgraded to hold", -0.6],
  ["short seller", -0.9],
  ["short-seller report", -1.0],
  ["accounting irregularities", -1.0],
  ["securities fraud", -1.0],
  ["class action", -0.7],
  ["under investigation", -0.8],
  ["data breach", -0.7],
  ["product recall", -0.8],
  ["trading halted", -0.8],
  ["going concern", -1.0],
  ["chapter 11", -1.0],
  ["stock offering", -0.7],
  ["share offering", -0.7],
  ["equity raise", -0.7],
  ["capital raise", -0.6],
  ["dilutive offering", -0.9],
  ["failed to meet", -0.8],
  ["missed primary endpoint", -1.0],
  ["clinical hold", -1.0],
  ["ceo steps down", -0.6],
  ["ceo resigns", -0.6],
  ["cfo resigns", -0.7],
  ["job cuts", -0.3],
  ["layoffs", -0.2],
];

const WORDS: Record<string, number> = {
  surges: 0.8, surge: 0.7, soars: 0.9, soar: 0.8, jumps: 0.7, jump: 0.6, rallies: 0.7, rally: 0.6,
  climbs: 0.5, gains: 0.5, rises: 0.4, rise: 0.35, advances: 0.4, outperform: 0.7, outperforms: 0.7,
  upgrade: 0.8, upgrades: 0.8, upgraded: 0.8, bullish: 0.7, optimistic: 0.5, strong: 0.5, strength: 0.5,
  robust: 0.5, solid: 0.4, beat: 0.7, beats: 0.7, exceeded: 0.7, exceeds: 0.7, growth: 0.35, profit: 0.3,
  profitable: 0.5, breakthrough: 0.8, approval: 0.7, approved: 0.7, wins: 0.6, won: 0.5, award: 0.4,
  expansion: 0.35, partnership: 0.4, launch: 0.3, launches: 0.3, accelerating: 0.5, momentum: 0.4,
  buyback: 0.6, dividend: 0.3, acquire: 0.5, acquires: 0.6, acquisition: 0.45, bid: 0.5, premium: 0.4,
  rebound: 0.5, recovery: 0.4, boosted: 0.5, boost: 0.5, raises: 0.5, upbeat: 0.6, encouraging: 0.5,

  plunges: -0.9, plunge: -0.8, plummets: -0.9, tumbles: -0.8, tumble: -0.7, sinks: -0.7, slumps: -0.7,
  slides: -0.5, falls: -0.4, fall: -0.35, drops: -0.5, declines: -0.45, sheds: -0.4, retreats: -0.4,
  underperform: -0.7, downgrade: -0.8, downgrades: -0.8, downgraded: -0.8, bearish: -0.7, pessimistic: -0.5,
  weak: -0.5, weakness: -0.5, weaker: -0.5, soft: -0.35, sluggish: -0.5, disappointing: -0.8,
  disappoints: -0.8, miss: -0.6, missed: -0.7, misses: -0.7, warning: -0.7, warns: -0.7, cuts: -0.5,
  cut: -0.45, slashed: -0.8, slashes: -0.8, halt: -0.6, halted: -0.7, suspended: -0.7, suspension: -0.6,
  probe: -0.7, investigation: -0.7, lawsuit: -0.6, sued: -0.6, sues: -0.5, fined: -0.6, fine: -0.4,
  penalty: -0.5, fraud: -1.0, bankruptcy: -1.0, insolvency: -1.0, default: -0.8, delisting: -0.9,
  recall: -0.7, breach: -0.6, resign: -0.5, resigns: -0.5, resignation: -0.5, ousted: -0.6,
  restructuring: -0.35, writedown: -0.7, impairment: -0.6, dilution: -0.7, delay: -0.5, delayed: -0.5,
  setback: -0.7, halts: -0.6, risk: -0.25, concerns: -0.4, concern: -0.35, scrutiny: -0.5, curbs: -0.4,
};

/** Words that invert the polarity of the next few tokens. */
const NEGATORS = new Set(["not", "no", "never", "without", "fails", "fail", "failed", "denies", "denied", "avoids", "halts"]);

/** Hedges that mean the headline is speculation, so its score should count for less. */
const HEDGES = /\b(could|may|might|reportedly|rumou?r|speculation|considering|weighs|explores|mulls|eyes)\b/;

export interface EventTag {
  tag: string;
  label: string;
  /** True when the event itself resolves before the next open, i.e. real gap risk. */
  binary: boolean;
  direction: "up" | "down" | "unknown";
}

const EVENTS: { tag: string; re: RegExp; label: string; binary: boolean; direction: "up" | "down" | "unknown" }[] = [
  { tag: "earnings", re: /\b(earnings|results|quarterly|q[1-4]\s|full[- ]year results|interim results|trading (statement|update))\b/, label: "earnings or results", binary: true, direction: "unknown" },
  { tag: "guidance", re: /\b(guidance|outlook|forecast)\b/, label: "guidance change", binary: true, direction: "unknown" },
  { tag: "clinical", re: /\b(fda|ema|phase [123]|clinical|trial results|endpoint|approval)\b/, label: "regulatory or clinical decision", binary: true, direction: "unknown" },
  { tag: "mna", re: /\b(merger|acquisition|takeover|buyout|acquire[sd]?|bid for|stake in)\b/, label: "M&A", binary: true, direction: "up" },
  { tag: "offering", re: /\b(offering|placing|share sale|equity raise|convertible notes|dilut)\b/, label: "equity issuance", binary: true, direction: "down" },
  { tag: "rating", re: /\b(upgrade[sd]?|downgrade[sd]?|price target|initiated coverage|rating)\b/, label: "analyst action", binary: false, direction: "unknown" },
  { tag: "legal", re: /\b(lawsuit|litigation|probe|investigation|sec charges|settlement|antitrust|fined)\b/, label: "legal or regulatory action", binary: false, direction: "down" },
  { tag: "management", re: /\b(ceo|cfo|chairman|chief executive)\b.*\b(resign|step down|steps down|depart|ousted|appoint)/, label: "management change", binary: true, direction: "unknown" },
  { tag: "distress", re: /\b(bankruptcy|chapter 11|going concern|delisting|insolvenc|default)\b/, label: "financial distress", binary: true, direction: "down" },
  { tag: "shortseller", re: /\b(short[- ]seller|short report|muddy waters|hindenburg)\b/, label: "short-seller report", binary: true, direction: "down" },
  { tag: "capitalreturn", re: /\b(buyback|repurchase|special dividend|dividend (increase|hike))\b/, label: "capital return", binary: false, direction: "up" },
  { tag: "halt", re: /\b(trading halt|halted|suspended from trading)\b/, label: "trading halt", binary: true, direction: "down" },
];

const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$.\s-]/g, " ").split(/\s+/).filter(Boolean);

/** Score one headline in -1..1. Exported for tests. */
export function scoreHeadline(title: string): number {
  const text = title.toLowerCase();
  let total = 0;
  let hits = 0;

  let remaining = text;
  for (const [phrase, w] of PHRASES) {
    if (remaining.includes(phrase)) {
      total += w;
      hits++;
      remaining = remaining.split(phrase).join(" ");
    }
  }

  const tokens = tokenize(remaining);
  for (let i = 0; i < tokens.length; i++) {
    const w = WORDS[tokens[i]];
    if (w === undefined) continue;
    const negated = tokens.slice(Math.max(0, i - 3), i).some((t) => NEGATORS.has(t));
    total += negated ? -w * 0.8 : w;
    hits++;
  }

  if (hits === 0) return 0;
  // Divide by sqrt(hits) rather than hits: several agreeing signals should read stronger than one,
  // but not linearly stronger, and tanh keeps the result inside -1..1.
  let score = Math.tanh(total / Math.sqrt(hits));
  if (HEDGES.test(text)) score *= 0.5;
  return clamp(score, -1, 1);
}

export function classifyHeadline(title: string): EventTag[] {
  const text = title.toLowerCase();
  return EVENTS.filter((e) => e.re.test(text)).map(({ tag, label, binary, direction }) => ({ tag, label, binary, direction }));
}

interface RawNews {
  title: string;
  link: string;
  publisher: string;
  publishedAt: Date;
}

async function fromSearch(symbol: string): Promise<RawNews[]> {
  const res = (await yf.search(symbol, { newsCount: 20, quotesCount: 0, enableFuzzyQuery: false }, OPTS)) as {
    news?: { title?: string; link?: string; publisher?: string; providerPublishTime?: string | number | Date }[];
  };
  return (res.news ?? [])
    .filter((n) => n.title && n.link)
    .map((n) => ({
      title: n.title!,
      link: n.link!,
      publisher: n.publisher ?? "Yahoo Finance",
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime) : new Date(),
    }));
}

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/** Keyless RSS fallback for when the search endpoint is rate limited or returns nothing. */
async function fromRss(symbol: string): Promise<RawNews[]> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const pick = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? unescapeXml(m[1]) : "";
  };
  return items
    .map((block) => ({
      title: pick(block, "title"),
      link: pick(block, "link"),
      publisher: "Yahoo Finance",
      publishedAt: new Date(pick(block, "pubDate") || Date.now()),
    }))
    .filter((n) => n.title && n.link);
}

export async function fetchHeadlines(symbol: string): Promise<RawNews[]> {
  let items: RawNews[] = [];
  try {
    items = await fromSearch(symbol);
  } catch {
    /* fall through to RSS */
  }
  if (items.length === 0) {
    try {
      items = await fromRss(symbol);
    } catch {
      /* no news is a valid state, not an error */
    }
  }
  const seen = new Set<string>();
  return items
    .filter((n) => Number.isFinite(n.publishedAt.getTime()))
    .filter((n) => {
      const k = n.title.toLowerCase().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, 20);
}

export interface NewsAnalysis {
  items: NewsItem[];
  /** Recency-weighted sentiment in -1..1. */
  sentiment: number;
  /** Headlines in the last 24h divided by the average daily rate over the window; 1 = typical. */
  burst: number;
  events: EventTag[];
  /** True when an unresolved binary event is flagged in the last 24h. */
  binaryEventPending: boolean;
  catalysts: string[];
  risks: string[];
}

/** Headlines decay with a 36-hour half-life: yesterday's news barely moves tonight's open. */
const recencyWeight = (publishedAt: Date, now: number) => Math.pow(0.5, Math.max(0, now - publishedAt.getTime()) / (36 * 3_600_000));

export function analyseHeadlines(raw: RawNews[], now = Date.now()): NewsAnalysis {
  const items: NewsItem[] = raw.map((n) => ({
    title: n.title,
    url: n.link,
    publisher: n.publisher,
    publishedAt: n.publishedAt.toISOString(),
    score: scoreHeadline(n.title),
    tags: classifyHeadline(n.title).map((e) => e.tag),
  }));

  let wsum = 0;
  let wtot = 0;
  for (const [i, n] of raw.entries()) {
    const w = recencyWeight(n.publishedAt, now);
    wsum += items[i].score * w;
    wtot += w;
  }
  const sentiment = wtot > 0 ? clamp(wsum / wtot, -1, 1) : 0;

  const last24 = raw.filter((n) => now - n.publishedAt.getTime() < 86_400_000).length;
  const spanDays = raw.length > 1 ? Math.max(1, (now - raw[raw.length - 1].publishedAt.getTime()) / 86_400_000) : 1;
  const burst = raw.length > 0 ? clamp(last24 / Math.max(0.5, raw.length / spanDays), 0, 10) : 1;

  const recent = raw.filter((n) => now - n.publishedAt.getTime() < 48 * 3_600_000);
  const events = [...new Map(recent.flatMap((n) => classifyHeadline(n.title)).map((e) => [e.tag, e])).values()];

  const fresh = raw.filter((n) => now - n.publishedAt.getTime() < 24 * 3_600_000);
  const binaryEventPending = fresh.some((n) => classifyHeadline(n.title).some((e) => e.binary));

  const catalysts = items
    .filter((n) => n.score > 0.25 && now - new Date(n.publishedAt).getTime() < 72 * 3_600_000)
    .slice(0, 4)
    .map((n) => `${n.title} (${n.publisher})`);
  const risks = items
    .filter((n) => n.score < -0.25 && now - new Date(n.publishedAt).getTime() < 72 * 3_600_000)
    .slice(0, 4)
    .map((n) => `${n.title} (${n.publisher})`);

  return { items, sentiment, burst, events, binaryEventPending, catalysts, risks };
}

export async function analyseNews(symbol: string): Promise<NewsAnalysis> {
  return analyseHeadlines(await fetchHeadlines(symbol));
}

/** Average absolute sentiment, used as a crude "is anything happening" measure. */
export const newsIntensity = (a: NewsAnalysis) => mean(a.items.map((i) => Math.abs(i.score)));
