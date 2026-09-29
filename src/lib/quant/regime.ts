/**
 * Market regime, computed from free index/volatility/sector quotes instead of asking a model
 * what it thinks the mood is.
 *
 * The signals are chosen for what actually conditions an overnight gap:
 * - For UK runs the US session is already ~2 hours old when the LSE closes, so today's S&P move and
 *   the futures basis are live information about tonight's FTSE gap.
 * - For US runs the index's late-day direction, the volatility regime and breadth are what is
 *   observable before the close.
 * - Known calendar events (payrolls, index expiry, quarter end) are derivable from the date alone.
 */

import { getDailyBars, getQuotes, type Quote } from "../market/data";
import { clamp, finite, sma } from "./stats";
import type { MarketContext, Source } from "./schemas";

const US_SYMBOLS = ["^GSPC", "^IXIC", "ES=F", "NQ=F", "^VIX"];
const UK_SYMBOLS = ["^FTSE", "^FTMC", "GBPUSD=X"];
const SECTOR_ETFS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"];
/** Megacaps whose after-the-close results drag the whole US tape overnight. */
const BELLWETHERS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM"];

export interface Regime {
  context: MarketContext;
  /** Index move so far today, in percent. Positive = market is up into the close. */
  indexChangePct: number;
  /** For UK runs: how the (already open) US session is trading. Null for US runs. */
  leadMarketChangePct: number | null;
  /** Futures price relative to the cash index, in percent. */
  futuresBasisPct: number | null;
  vix: number | null;
  vixChangePct: number | null;
  breadth: number | null;
  /** Index close relative to its 20-day average, in percent. */
  indexVsSma20Pct: number;
  riskOff: boolean;
}

const yahooUrl = (s: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(s)}`;

/** Deterministic, date-derivable events that reliably move the overnight session. */
export function calendarEvents(now: Date, market: "US" | "UK"): string[] {
  const out: string[] = [];
  const next = new Date(now.getTime() + 86_400_000);
  const dow = next.getUTCDay();
  const dom = next.getUTCDate();
  const month = next.getUTCMonth();

  if (dow === 5 && dom <= 7) out.push("US non-farm payrolls are released tomorrow morning, before the US open");
  if (dow === 5 && dom >= 15 && dom <= 21) {
    out.push(month % 3 === 2 ? "Quarterly triple witching tomorrow: index and option expiry, unusually heavy open" : "Monthly option expiry tomorrow");
  }
  const endOfMonth = new Date(Date.UTC(next.getUTCFullYear(), month + 1, 0)).getUTCDate();
  if (dom === endOfMonth) out.push("Month end tomorrow: index rebalancing flows around the open");
  if (dom === endOfMonth && month % 3 === 2) out.push("Quarter end tomorrow: larger than usual rebalancing");
  if (market === "UK" && dow >= 1 && dow <= 5) out.push("The UK open follows a full US session and the Asian session");
  return out;
}

/** Megacap results due before the next open are market-wide gap risk, not just single-stock risk. */
async function bellwetherEarnings(): Promise<string[]> {
  const horizon = 36 * 3_600_000;
  const results = await Promise.all(
    BELLWETHERS.map(async (s) => {
      try {
        const { getNextEarnings } = await import("../market/data");
        const d = await getNextEarnings(s);
        if (!d) return null;
        const dt = d.getTime() - Date.now();
        return dt > -12 * 3_600_000 && dt < horizon ? s : null;
      } catch {
        return null;
      }
    }),
  );
  const due = results.filter((s): s is string => !!s);
  return due.length ? [`Megacap results before the next open: ${due.join(", ")}`] : [];
}

function trendOf(vsSma20: number, vsSma50: number): MarketContext["trendRegime"] {
  if (vsSma20 > 0.5 && vsSma50 > 1) return "bull";
  if (vsSma20 < -0.5 && vsSma50 < -1) return "bear";
  return "neutral";
}

function volOf(vix: number | null): MarketContext["volRegime"] {
  if (vix == null) return "unknown";
  if (vix < 15) return "calm";
  if (vix < 24) return "normal";
  return "stressed";
}

export async function getRegime(market: "US" | "UK", now = new Date()): Promise<Regime> {
  const symbols = [...new Set([...US_SYMBOLS, ...(market === "UK" ? UK_SYMBOLS : []), ...SECTOR_ETFS])];
  const quotes = await getQuotes(symbols);
  const q = (s: string): Quote | undefined => quotes.get(s);

  const indexSymbol = market === "UK" ? "^FTSE" : "^GSPC";
  const index = q(indexSymbol);
  const spx = q("^GSPC");
  const es = q("ES=F");
  const vixQ = q("^VIX");

  const indexChangePct = finite(index?.changePct ?? 0);
  const leadMarketChangePct = market === "UK" ? (spx ? finite(spx.changePct) : null) : null;
  const futuresBasisPct = es && spx && spx.price > 0 ? finite((es.price / spx.price - 1) * 100) : null;
  const vix = vixQ?.price ?? null;
  const vixChangePct = vixQ ? finite(vixQ.changePct) : null;

  let indexVsSma20Pct = 0;
  let indexVsSma50Pct = 0;
  try {
    const bars = await getDailyBars(indexSymbol, 120);
    const closes = bars.map((b) => b.close);
    const last = index?.price ?? closes.at(-1) ?? 0;
    const s20 = sma(closes, 20);
    const s50 = sma(closes, 50);
    if (s20 > 0) indexVsSma20Pct = finite((last / s20 - 1) * 100);
    if (s50 > 0) indexVsSma50Pct = finite((last / s50 - 1) * 100);
  } catch {
    /* breadth and trend degrade gracefully to neutral */
  }

  const sectors = SECTOR_ETFS.map((s) => q(s)).filter((x): x is Quote => !!x);
  const breadth = sectors.length >= 5 ? sectors.filter((s) => s.changePct > 0).length / sectors.length : null;

  const trendRegime = trendOf(indexVsSma20Pct, indexVsSma50Pct);
  const volRegime = volOf(vix);
  const riskOff = volRegime === "stressed" || (vixChangePct != null && vixChangePct > 12) || trendRegime === "bear";

  const riskEventsTonight = [...calendarEvents(now, market), ...(await bellwetherEarnings())];

  const bias: MarketContext["futuresBias"] =
    market === "UK"
      ? leadMarketChangePct == null
        ? "unknown"
        : leadMarketChangePct > 0.3
          ? "up"
          : leadMarketChangePct < -0.3
            ? "down"
            : "flat"
      : futuresBasisPct == null
        ? indexChangePct > 0.4
          ? "up"
          : indexChangePct < -0.4
            ? "down"
            : "flat"
        : futuresBasisPct > 0.15
          ? "up"
          : futuresBasisPct < -0.15
            ? "down"
            : "flat";

  const parts: string[] = [];
  parts.push(`${indexSymbol} is ${indexChangePct >= 0 ? "up" : "down"} ${Math.abs(indexChangePct).toFixed(2)}% today and sits ${indexVsSma20Pct >= 0 ? "above" : "below"} its 20-day average by ${Math.abs(indexVsSma20Pct).toFixed(1)}% (${trendRegime} trend).`);
  if (vix != null) parts.push(`VIX ${vix.toFixed(1)}${vixChangePct != null ? ` (${vixChangePct >= 0 ? "+" : ""}${vixChangePct.toFixed(1)}% today)` : ""}, a ${volRegime} volatility regime.`);
  if (breadth != null) parts.push(`${Math.round(breadth * 100)}% of US sectors are green.`);
  if (market === "UK" && leadMarketChangePct != null) parts.push(`The US session, which runs on past the London close, is ${leadMarketChangePct >= 0 ? "up" : "down"} ${Math.abs(leadMarketChangePct).toFixed(2)}%.`);
  if (futuresBasisPct != null) parts.push(`S&P futures are ${futuresBasisPct >= 0 ? "above" : "below"} cash by ${Math.abs(futuresBasisPct).toFixed(2)}%.`);
  if (riskOff) parts.push("Conditions are risk-off, so overnight gaps skew wider and more negative.");

  const sources: Source[] = [
    { title: `${indexSymbol} quote`, url: yahooUrl(indexSymbol) },
    ...(vixQ ? [{ title: "CBOE Volatility Index", url: yahooUrl("^VIX") }] : []),
    ...(es ? [{ title: "S&P 500 futures", url: yahooUrl("ES=F") }] : []),
  ];

  return {
    context: {
      summary: parts.join(" "),
      riskEventsTonight,
      futuresBias: bias,
      sources,
      futuresGapPct: market === "UK" ? leadMarketChangePct : futuresBasisPct,
      vix,
      vixChangePct,
      breadth,
      trendRegime,
      volRegime,
    },
    indexChangePct,
    leadMarketChangePct,
    futuresBasisPct,
    vix,
    vixChangePct,
    breadth,
    indexVsSma20Pct,
    riskOff,
  };
}

/** Rebuilds the numeric part of a regime from a stored MarketContext (used when a run resumes). */
export function regimeFromContext(ctx: MarketContext | null): Omit<Regime, "context"> {
  return {
    indexChangePct: 0,
    leadMarketChangePct: null,
    futuresBasisPct: ctx?.futuresGapPct ?? null,
    vix: ctx?.vix ?? null,
    vixChangePct: ctx?.vixChangePct ?? null,
    breadth: ctx?.breadth ?? null,
    indexVsSma20Pct: 0,
    riskOff: ctx?.volRegime === "stressed" || ctx?.trendRegime === "bear",
  };
}

/** Market-wide multiplier on expected overnight dispersion. */
export const regimeVolMultiplier = (vix: number | null) => clamp(vix == null ? 1 : vix / 18, 0.7, 2.2);
