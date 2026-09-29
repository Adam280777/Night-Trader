import type { TradableInstrument } from "../t212/client";
import { marketOf, type Market } from "../t212/instruments";
import { getDailyBars, getNextEarnings, getQuotes, yahooSymbol, type Bar, type Quote } from "../market/data";

export interface Signals {
  ret1dPct: number;
  ret5dPct: number;
  ret20dPct: number;
  gapMeanPct: number; // mean overnight (close->next open) move over last 60 sessions
  gapStdPct: number;
  gapHitRate: number; // share of sessions with a positive overnight gap
  gapSharpe: number;
  atrPct: number;
  closeLocation: number; // 0 = closed at day low, 1 = at day high
  relVolume: number; // today's volume vs 3m avg
  dollarVolume: number;
  earningsWithin2d: boolean;
}

export interface Candidate {
  ticker: string;
  name: string;
  yahoo: string;
  market: Market;
  type: string;
  currency: string; // instrument currency (GBX for LSE pence)
  price: number;
  signals: Signals;
  score: number;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Pure: derive signals from daily bars (oldest first). Returns null if not enough history. */
export function computeSignals(bars: Bar[], q: Pick<Quote, "volume" | "avgVolume3m" | "price">): Omit<Signals, "earningsWithin2d"> | null {
  if (bars.length < 25) return null;
  const last = bars.at(-1)!;
  const closes = bars.map((b) => b.close);
  const ret = (n: number) => ((closes.at(-1)! / closes.at(-1 - n)!) - 1) * 100;

  const win = bars.slice(-61);
  const gaps: number[] = [];
  for (let i = 1; i < win.length; i++) gaps.push((win[i].open / win[i - 1].close - 1) * 100);
  const gapMean = mean(gaps);
  const gapStd = std(gaps);

  const atr = mean(bars.slice(-14).map((b) => ((b.high - b.low) / b.close) * 100));
  const range = last.high - last.low;

  return {
    ret1dPct: ret(1),
    ret5dPct: ret(5),
    ret20dPct: ret(20),
    gapMeanPct: gapMean,
    gapStdPct: gapStd,
    gapHitRate: gaps.filter((g) => g > 0).length / Math.max(1, gaps.length),
    gapSharpe: gapStd > 0 ? gapMean / gapStd : 0,
    atrPct: atr,
    closeLocation: range > 0 ? (last.close - last.low) / range : 0.5,
    relVolume: q.avgVolume3m > 0 ? q.volume / q.avgVolume3m : 1,
    dollarVolume: q.avgVolume3m * q.price,
  };
}

/**
 * Transparent heuristic used only to pick a shortlist for the AI to research.
 * Weights are deliberately simple; signals are stored per candidate so the learning
 * loop can later test which ones actually predicted overnight returns.
 */
export function scoreSignals(s: Omit<Signals, "earningsWithin2d">): number {
  return (
    1.0 * clamp(s.gapSharpe, -1, 1) +
    0.3 * clamp(s.ret5dPct / 5, -1, 1) +
    0.3 * (s.closeLocation - 0.5) * 2 +
    0.2 * Math.log(clamp(s.relVolume, 0.25, 4)) -
    0.15 * clamp(s.atrPct / 4, 0, 2) // penalise very volatile names: bigger overnight gap risk
  );
}

interface ScreenOpts {
  market: Market;
  minDollarVolume: number; // in instrument currency
  shortlist: number;
  excludeTickers?: Set<string>;
}

export async function screenUniverse(instruments: TradableInstrument[], o: ScreenOpts): Promise<Candidate[]> {
  const pool = instruments
    .filter((i) => (i.type === "STOCK" || i.type === "ETF") && marketOf(i) === o.market)
    .filter((i) => !o.excludeTickers?.has(i.ticker))
    .map((i) => ({ i, y: yahooSymbol(i) }))
    .filter((x): x is { i: TradableInstrument; y: string } => !!x.y);

  const quotes = await getQuotes(pool.map((p) => p.y));

  // Stage 1: cheap liquidity filter on quotes alone.
  const liquid = pool
    .map((p) => ({ ...p, q: quotes.get(p.y) }))
    .filter((p): p is typeof p & { q: Quote } => !!p.q)
    .filter((p) => {
      const price = p.q.currency === "GBp" || p.q.currency === "GBX" ? p.q.price / 100 : p.q.price;
      return price >= 1 && p.q.avgVolume3m * price >= o.minDollarVolume && (p.q.marketCap ?? 0) >= 1e9;
    })
    .sort((a, b) => b.q.avgVolume3m * b.q.price - a.q.avgVolume3m * a.q.price)
    .slice(0, 60);

  // Stage 2: history-based signals for the most liquid names.
  const scored: Candidate[] = [];
  for (const p of liquid) {
    try {
      const bars = await getDailyBars(p.y, 90);
      const sig = computeSignals(bars, p.q);
      if (!sig) continue;
      scored.push({
        ticker: p.i.ticker,
        name: p.i.name,
        yahoo: p.y,
        market: o.market,
        type: p.i.type,
        currency: p.i.currencyCode,
        price: p.q.price,
        signals: { ...sig, earningsWithin2d: false },
        score: scoreSignals(sig),
      });
    } catch {
      /* skip symbols Yahoo can't serve */
    }
  }

  const top = scored.sort((a, b) => b.score - a.score).slice(0, o.shortlist);
  await Promise.all(
    top.map(async (c) => {
      const d = await getNextEarnings(c.yahoo);
      c.signals.earningsWithin2d = !!d && d.getTime() - Date.now() < 2 * 86_400_000 && d.getTime() > Date.now() - 86_400_000;
    }),
  );
  return top;
}
