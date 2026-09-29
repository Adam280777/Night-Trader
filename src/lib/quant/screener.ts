import type { TradableInstrument } from "../t212/client";
import { marketOf, type Market } from "../t212/instruments";
import { getDailyBars, getNextEarnings, getQuotes, yahooSymbol, type Bar, type Quote } from "../market/data";
import { clamp, finite, mean, rsi, sma, std, winsorize } from "./stats";

/**
 * Price-derived signals. Everything here is computable from free daily bars plus one quote, and is
 * chosen for relevance to the close-to-next-open move specifically rather than to returns in general.
 */
export interface Signals {
  ret1dPct: number;
  ret5dPct: number;
  ret20dPct: number;
  /** Mean overnight (close -> next open) move over the sample window. */
  gapMeanPct: number;
  gapStdPct: number;
  gapHitRate: number;
  gapSharpe: number;
  /** t-statistic of the mean gap: separates a real drift from a small-sample fluke. */
  gapTStat: number;
  /** Mean gap over just the last 20 sessions, to catch a regime change in the name. */
  gapRecentPct: number;
  /** Mean gap on the weekday the next open falls on. */
  gapWeekdayPct: number;
  /** Share of total return earned overnight rather than intraday; persistently positive for some names. */
  overnightShare: number;
  atrPct: number;
  realizedVolPct: number;
  closeLocation: number;
  intradayRangePct: number;
  relVolume: number;
  volumeTrend: number;
  dollarVolume: number;
  rsi14: number;
  vsSma20Pct: number;
  vsSma50Pct: number;
  from52wHighPct: number;
  earningsWithin2d: boolean;
}

export interface Candidate {
  ticker: string;
  name: string;
  yahoo: string;
  market: Market;
  type: string;
  currency: string;
  price: number;
  signals: Signals;
  score: number;
}

/** Overnight (close -> next open) returns in percent, oldest first, paired with the open's weekday. */
export function overnightGaps(bars: Bar[]): { pct: number; weekday: number }[] {
  const out: { pct: number; weekday: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    if (!(prev > 0) || !(bars[i].open > 0)) continue;
    out.push({ pct: (bars[i].open / prev - 1) * 100, weekday: bars[i].date.getUTCDay() });
  }
  return out;
}

/** Intraday (open -> close) returns in percent, oldest first. */
export function intradayReturns(bars: Bar[]): number[] {
  return bars.filter((b) => b.open > 0).map((b) => (b.close / b.open - 1) * 100);
}

/** Pure: derive signals from daily bars (oldest first). Returns null without enough history. */
export function computeSignals(
  bars: Bar[],
  q: Pick<Quote, "volume" | "avgVolume3m" | "price">,
  nextOpenWeekday: number,
): Omit<Signals, "earningsWithin2d"> | null {
  if (bars.length < 25) return null;
  const last = bars.at(-1)!;
  const closes = bars.map((b) => b.close);
  const ret = (n: number) => (closes.length > n ? (closes.at(-1)! / closes.at(-1 - n)! - 1) * 100 : 0);

  const gapsAll = overnightGaps(bars);
  const window = gapsAll.slice(-120);
  const gaps = winsorize(window.map((g) => g.pct));
  const gapMean = mean(gaps);
  const gapStd = std(gaps);
  const gapTStat = gapStd > 0 && gaps.length > 1 ? (gapMean / gapStd) * Math.sqrt(gaps.length) : 0;

  const weekdayGaps = window.filter((g) => g.weekday === nextOpenWeekday).map((g) => g.pct);

  const intraday = intradayReturns(bars.slice(-120));
  const totalOvernight = gaps.reduce((s, x) => s + x, 0);
  const totalIntraday = intraday.reduce((s, x) => s + x, 0);
  const denom = Math.abs(totalOvernight) + Math.abs(totalIntraday);

  const dailyRets: number[] = [];
  for (let i = 1; i < closes.length; i++) dailyRets.push((closes[i] / closes[i - 1] - 1) * 100);

  const atr = mean(bars.slice(-14).map((b) => ((b.high - b.low) / b.close) * 100));
  const range = last.high - last.low;
  const vols = bars.map((b) => b.volume);
  const recentVol = mean(vols.slice(-5));
  const baseVol = mean(vols.slice(-60, -5));
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const high52 = Math.max(...bars.slice(-252).map((b) => b.high));

  return {
    ret1dPct: finite(ret(1)),
    ret5dPct: finite(ret(5)),
    ret20dPct: finite(ret(20)),
    gapMeanPct: finite(gapMean),
    gapStdPct: finite(gapStd),
    gapHitRate: gaps.length ? gaps.filter((g) => g > 0).length / gaps.length : 0.5,
    gapSharpe: finite(gapStd > 0 ? gapMean / gapStd : 0),
    gapTStat: finite(gapTStat),
    gapRecentPct: finite(mean(gaps.slice(-20))),
    gapWeekdayPct: finite(weekdayGaps.length >= 5 ? mean(winsorize(weekdayGaps)) : gapMean),
    overnightShare: finite(denom > 0 ? totalOvernight / denom : 0),
    atrPct: finite(atr),
    realizedVolPct: finite(std(dailyRets.slice(-20))),
    closeLocation: finite(range > 0 ? (last.close - last.low) / range : 0.5, 0.5),
    intradayRangePct: finite(last.close > 0 ? (range / last.close) * 100 : 0),
    relVolume: finite(q.avgVolume3m > 0 ? q.volume / q.avgVolume3m : 1, 1),
    volumeTrend: finite(baseVol > 0 ? recentVol / baseVol : 1, 1),
    dollarVolume: finite(q.avgVolume3m * q.price),
    rsi14: finite(rsi(closes, 14), 50),
    vsSma20Pct: finite(s20 > 0 ? (last.close / s20 - 1) * 100 : 0),
    vsSma50Pct: finite(s50 > 0 ? (last.close / s50 - 1) * 100 : 0),
    from52wHighPct: finite(high52 > 0 ? (last.close / high52 - 1) * 100 : 0),
  };
}

/**
 * Transparent heuristic used only to pick the shortlist the full engine then evaluates properly.
 * It deliberately favours breadth of setup types over raw conviction so the learning loop keeps
 * seeing a varied sample of outcomes.
 */
export function scoreSignals(s: Omit<Signals, "earningsWithin2d">): number {
  return (
    0.9 * clamp(s.gapSharpe, -1, 1) +
    0.5 * clamp(s.gapTStat / 3, -1, 1) +
    0.3 * clamp(s.overnightShare, -1, 1) +
    0.3 * (s.closeLocation - 0.5) * 2 +
    0.25 * clamp(s.ret5dPct / 5, -1, 1) +
    0.2 * Math.log(clamp(s.relVolume, 0.25, 4)) -
    0.2 * clamp(s.ret1dPct / 5, -1, 1) - // a big intraday run-up tends to mean-revert overnight
    0.15 * clamp(s.atrPct / 4, 0, 2)
  );
}

interface ScreenOpts {
  market: Market;
  minDollarVolume: number;
  shortlist: number;
  /** Weekday (0-6, UTC) of the open we are trading into. */
  nextOpenWeekday: number;
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
      const bars = await getDailyBars(p.y, 260);
      const sig = computeSignals(bars, p.q, o.nextOpenWeekday);
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
