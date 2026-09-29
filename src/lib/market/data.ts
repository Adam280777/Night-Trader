import YahooFinance from "yahoo-finance2";
import type { TradableInstrument } from "../t212/client";
import { marketOf } from "../t212/instruments";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
// Yahoo's response schema drifts often; we validate the fields we use ourselves.
const OPTS = { validateResult: false } as const;

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  changePct: number;
  volume: number;
  avgVolume3m: number;
  marketCap: number | null;
  currency: string;
  name: string;
}

/** Map a T212 instrument to a Yahoo symbol. US: AAPL; LSE: VOD.L */
export function yahooSymbol(i: Pick<TradableInstrument, "ticker" | "shortName" | "currencyCode">): string | null {
  const m = marketOf(i);
  // LSE tickers look like "VODl_EQ": the trailing lower-case "l" is T212's exchange marker.
  const base = i.shortName ?? (m === "UK" ? i.ticker.split("_")[0].replace(/l$/, "") : i.ticker.split("_")[0]);
  if (!base) return null;
  if (m === "US") return base.replace(/\./g, "-"); // BRK.B -> BRK-B
  if (m === "UK") return `${base.replace(/\.$/, "")}.L`;
  return null;
}

export async function getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const chunk = 100;
  for (let i = 0; i < symbols.length; i += chunk) {
    const batch = symbols.slice(i, i + chunk);
    try {
      const res = (await yf.quote(batch, {}, OPTS)) as any[];
      for (const q of res) {
        if (!q?.symbol || !(q.regularMarketPrice > 0)) continue;
        out.set(q.symbol, {
          symbol: q.symbol,
          price: q.regularMarketPrice,
          prevClose: q.regularMarketPreviousClose ?? q.regularMarketPrice,
          changePct: q.regularMarketChangePercent ?? 0,
          volume: q.regularMarketVolume ?? 0,
          avgVolume3m: q.averageDailyVolume3Month ?? q.regularMarketVolume ?? 0,
          marketCap: q.marketCap ?? null,
          currency: q.currency ?? "USD",
          name: q.shortName ?? q.longName ?? q.symbol,
        });
      }
    } catch {
      /* a bad batch shouldn't kill the whole universe scan */
    }
  }
  return out;
}

export interface Bar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getDailyBars(symbol: string, days = 90): Promise<Bar[]> {
  const period1 = new Date(Date.now() - days * 86_400_000 * 1.6);
  const res = (await yf.chart(symbol, { period1, interval: "1d" }, OPTS)) as any;
  return (res.quotes ?? [])
    .filter((b: any) => b.open != null && b.close != null && b.high != null && b.low != null)
    .map((b: any) => ({
      date: new Date(b.date),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? 0,
    }));
}

/** Next earnings date if known (overnight earnings = binary gap risk). */
export async function getNextEarnings(symbol: string): Promise<Date | null> {
  try {
    const r = (await yf.quoteSummary(symbol, { modules: ["calendarEvents"] }, OPTS)) as any;
    const d = r?.calendarEvents?.earnings?.earningsDate?.[0];
    return d ? new Date(d) : null;
  } catch {
    return null;
  }
}

/** Multiplier converting 1 unit of `from` (major currency; GBX handled by caller) into `to`. */
export async function fxRate(from: string, to: string): Promise<number> {
  const f = from === "GBX" ? "GBP" : from;
  if (f === to) return 1;
  const res = (await yf.quote(`${f}${to}=X`, {}, OPTS)) as any;
  const p = res?.regularMarketPrice;
  if (!(p > 0)) throw new Error(`No FX rate for ${f}->${to}`);
  return p;
}
