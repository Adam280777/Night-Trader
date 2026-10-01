import YahooFinance from "yahoo-finance2";
import type { TradableInstrument } from "../t212/client";
import { marketOf } from "../t212/instruments";
import type { Fundamentals } from "../quant/schemas";
import { getFmpEarnings, tryFmpClient } from "./fmp";
import { getSettings } from "../config";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
// Yahoo's response schema drifts often; we validate the fields we use ourselves.
const OPTS = { validateResult: false } as const;

/** A hung Yahoo call must not be able to eat a whole tick. */
const YAHOO_TIMEOUT_MS = 15_000;

export interface YahooStats {
  calls: number;
  failures: number;
  timeouts: number;
  totalMs: number;
  lastError: string | null;
}
const stats: YahooStats = { calls: 0, failures: 0, timeouts: 0, totalMs: 0, lastError: null };

/** Counters since the last reset, for per-job telemetry. Per process, which is what one tick runs in. */
export function yahooStats(reset = false): YahooStats {
  const copy = { ...stats };
  if (reset) Object.assign(stats, { calls: 0, failures: 0, timeouts: 0, totalMs: 0, lastError: null });
  return copy;
}

async function yahoo<T>(label: string, call: () => Promise<T>): Promise<T> {
  const started = Date.now();
  stats.calls++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Yahoo ${label} timed out after ${YAHOO_TIMEOUT_MS / 1000}s`)), YAHOO_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    stats.failures++;
    if (String(err).includes("timed out")) stats.timeouts++;
    stats.lastError = `${label}: ${String(err).slice(0, 160)}`;
    throw err;
  } finally {
    clearTimeout(timer);
    stats.totalMs += Date.now() - started;
  }
}

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
  quoteAt: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  source?: "yahoo" | "fmp" | "fmp+yahoo";
  secondaryPrice?: number | null;
  divergencePct?: number | null;
  validationStatus?: "verified" | "single_source" | "unavailable";
}

export function providerDivergencePct(primary: number, secondary: number): number {
  if (!(primary > 0 && secondary > 0)) return Number.POSITIVE_INFINITY;
  return (Math.abs(primary - secondary) / ((primary + secondary) / 2)) * 100;
}

/**
 * Uses FMP as the real-time US price and Yahoo as an independent cross-check.
 * UK and non-equity symbols remain Yahoo-only because Starter coverage is US-only.
 */
export async function getValidatedQuotes(
  symbols: string[],
  market: "US" | "UK",
  deadline?: number,
): Promise<Map<string, Quote>> {
  const yahooQuotes = await getQuotes(symbols, deadline);
  const out = new Map<string, Quote>();
  for (const [symbol, quote] of yahooQuotes) {
    out.set(symbol, { ...quote, source: "yahoo", secondaryPrice: null, divergencePct: null, validationStatus: "single_source" });
  }
  if (market !== "US" || (deadline !== undefined && Date.now() >= deadline)) return out;

  if (!(await getSettings()).marketData.fmpEnabled) return out;
  const client = await tryFmpClient();
  if (!client) {
    for (const [symbol, quote] of out) out.set(symbol, { ...quote, validationStatus: "unavailable" });
    return out;
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, symbols.length) }, async () => {
      while (next < symbols.length && !(deadline !== undefined && Date.now() >= deadline)) {
        const symbol = symbols[next++];
        if (symbol.startsWith("^") || symbol.endsWith("=X") || symbol.endsWith("=F") || symbol.endsWith(".L")) continue;
        try {
          const fmp = await client.quote(symbol);
          if (!fmp) continue;
          const yahooQuote = yahooQuotes.get(symbol);
          const secondaryPrice = yahooQuote?.price ?? null;
          const divergencePct =
            secondaryPrice != null && secondaryPrice > 0
              ? providerDivergencePct(fmp.price, secondaryPrice)
              : null;
          const previous = yahooQuote ?? {
            symbol,
            price: fmp.price,
            prevClose: fmp.change != null ? fmp.price - fmp.change : fmp.price,
            changePct: fmp.changePercentage ?? 0,
            volume: fmp.volume ?? 0,
            avgVolume3m: fmp.averageVolume ?? fmp.volume ?? 0,
            marketCap: fmp.marketCap ?? null,
            currency: "USD",
            name: fmp.name ?? symbol,
            quoteAt: null,
            bid: null,
            ask: null,
            spreadPct: null,
          };

          out.set(symbol, {
            ...previous,
            price: fmp.price,
            prevClose: fmp.change != null ? fmp.price - fmp.change : previous.prevClose,
            changePct: fmp.changePercentage ?? previous.changePct,
            volume: fmp.volume ?? previous.volume,
            avgVolume3m: fmp.averageVolume ?? previous.avgVolume3m,
            marketCap: fmp.marketCap ?? previous.marketCap,
            name: fmp.name ?? previous.name,
            quoteAt: fmp.timestamp * 1000,
            source: yahooQuote ? "fmp+yahoo" : "fmp",
            secondaryPrice,
            divergencePct,
            validationStatus: yahooQuote ? "verified" : "single_source",
          });
        } catch {
          // FMP records the exact failure in provider telemetry; a Yahoo quote remains visibly single-source.
        }
      }
    }),
  );
  return out;
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

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" ? (x as Obj) : {});
const list = (x: unknown): Obj[] => (Array.isArray(x) ? x.map(obj) : []);
const instant = (x: unknown): number | null => {
  if (x instanceof Date) return Number.isFinite(x.getTime()) ? x.getTime() : null;
  if (typeof x === "number" && Number.isFinite(x)) return x < 1e12 ? x * 1000 : x;
  if (typeof x === "string") {
    const parsed = Date.parse(x);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export async function getQuotes(symbols: string[], deadline?: number): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const chunk = 100;
  for (let i = 0; i < symbols.length; i += chunk) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const batch = symbols.slice(i, i + chunk);
    try {
      const res = (await yahoo("quote", () => yf.quote(batch, {}, OPTS))) as unknown as Obj[];
      for (const q of res) {
        const price = num(q?.regularMarketPrice);
        if (!q?.symbol || !(price != null && price > 0)) continue;
        const bid = num(q.bid);
        const ask = num(q.ask);
        out.set(String(q.symbol), {
          symbol: String(q.symbol),
          price,
          prevClose: num(q.regularMarketPreviousClose) ?? price,
          changePct: num(q.regularMarketChangePercent) ?? 0,
          volume: num(q.regularMarketVolume) ?? 0,
          avgVolume3m: num(q.averageDailyVolume3Month) ?? num(q.regularMarketVolume) ?? 0,
          marketCap: num(q.marketCap),
          currency: typeof q.currency === "string" ? q.currency : "USD",
          name: String(q.shortName ?? q.longName ?? q.symbol),
          quoteAt: instant(q.regularMarketTime),
          bid,
          ask,
          spreadPct: bid != null && ask != null && bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null,
        });
      }
    } catch {
      /* a bad batch shouldn't kill the whole universe scan; the failure is counted in yahooStats */
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
  const res = obj(await yahoo(`chart ${symbol}`, () => yf.chart(symbol, { period1, interval: "1d" }, OPTS)));
  return list(res.quotes)
    .filter((b) => num(b.open) != null && num(b.close) != null && num(b.high) != null && num(b.low) != null)
    .map((b) => ({
      date: new Date(b.date as string | number | Date),
      open: b.open as number,
      high: b.high as number,
      low: b.low as number,
      close: b.close as number,
      volume: num(b.volume) ?? 0,
    }));
}

/** Five-minute bars for the low-frequency intraday strategy. Yahoo limits fine-grained history. */
export async function getIntradayBars(symbol: string, days = 5): Promise<Bar[]> {
  const period1 = new Date(Date.now() - days * 86_400_000);
  const res = obj(await yahoo(`intraday chart ${symbol}`, () => yf.chart(symbol, { period1, interval: "5m" }, OPTS)));
  return list(res.quotes)
    .filter((b) => instant(b.date) != null && num(b.open) != null && num(b.close) != null && num(b.high) != null && num(b.low) != null)
    .map((b) => ({
      date: new Date(instant(b.date)!),
      open: b.open as number,
      high: b.high as number,
      low: b.low as number,
      close: b.close as number,
      volume: num(b.volume) ?? 0,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Next earnings date if known (overnight earnings = binary gap risk). */
export async function getNextEarnings(symbol: string): Promise<Date | null> {
  if (!symbol.endsWith(".L") && (await getSettings()).marketData.fmpEnabled) {
    try {
      const fmp = await getFmpEarnings(symbol);
      if (fmp) return fmp;
    } catch {
      // Provider telemetry records the error; Yahoo remains an independent fallback.
    }
  }
  try {
    const r = obj(await yahoo(`earnings ${symbol}`, () => yf.quoteSummary(symbol, { modules: ["calendarEvents"] }, OPTS)));
    const earnings = obj(obj(r.calendarEvents).earnings);
    const d = Array.isArray(earnings.earningsDate) ? (earnings.earningsDate[0] as string | number | Date | undefined) : undefined;
    return d ? new Date(d) : null;
  } catch {
    return null;
  }
}

/** Analyst, short-interest and earnings-history facts for one symbol. Returns null when Yahoo has nothing usable. */
export async function getFundamentals(symbol: string, price?: number): Promise<Fundamentals | null> {
  try {
    const r = await yahoo(`fundamentals ${symbol}`, () =>
      yf.quoteSummary(symbol, { modules: ["financialData", "defaultKeyStatistics", "earningsHistory", "upgradeDowngradeHistory"] }, OPTS),
    );

    const root = obj(r);
    const fd = obj(root.financialData);
    const ks = obj(root.defaultKeyStatistics);
    const px = price ?? num(fd.currentPrice);
    const target = num(fd.targetMeanPrice);

    const surprises = list(obj(root.earningsHistory).history)
      .map((h) => {
        const actual = num(h.epsActual);
        const est = num(h.epsEstimate);
        return actual != null && est != null && Math.abs(est) > 0.01 ? ((actual - est) / Math.abs(est)) * 100 : null;
      })
      .filter((x): x is number => x != null)
      .slice(-4)
      .map((x) => Math.max(-100, Math.min(100, x)));

    const cutoff = Date.now() - 14 * 86_400_000;
    let net: number | null = null;
    for (const h of list(obj(root.upgradeDowngradeHistory).history)) {
      const t = h.epochGradeDate ? new Date(h.epochGradeDate as string | number | Date).getTime() : NaN;
      if (!(t >= cutoff)) continue;
      net = (net ?? 0) + (h.action === "up" ? 1 : h.action === "down" ? -1 : 0);
    }

    const out: Fundamentals = {
      analystMean: num(fd.recommendationMean),
      analystCount: num(fd.numberOfAnalystOpinions),
      targetUpsidePct: target != null && px != null && px > 0 ? Math.max(-80, Math.min(200, (target / px - 1) * 100)) : null,
      shortPctFloat: num(ks.shortPercentOfFloat),
      epsSurprisePct: surprises.length ? surprises.reduce((s, x) => s + x, 0) / surprises.length : null,
      netUpgrades14d: net,
      beta: num(ks.beta),
    };
    return Object.values(out).every((v) => v == null) ? null : out;
  } catch {
    return null;
  }
}

/** Multiplier converting 1 unit of `from` (major currency; GBX handled by caller) into `to`. */
export async function fxRate(from: string, to: string): Promise<number> {
  const f = from === "GBX" ? "GBP" : from;
  if (f === to) return 1;
  const res = obj(await yahoo(`fx ${f}${to}`, () => yf.quote(`${f}${to}=X`, {}, OPTS)));
  const p = num(res.regularMarketPrice);
  if (!(p != null && p > 0)) throw new Error(`No FX rate for ${f}->${to}`);
  return p;
}
