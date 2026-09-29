import type { Market } from "../t212/instruments";
import { clamp } from "./stats";
import type { Signals } from "./screener";

/**
 * Round-trip cost of an overnight trade, in percent of notional.
 *
 * Fixed leg: Trading 212 charges 0.15% FX conversion on each side of a non-GBP trade, and UK buys
 * pay 0.5% stamp duty. Variable leg: we cross the spread twice, and the spread widens with
 * volatility and narrows with liquidity, so it is estimated from the name's own ATR and turnover
 * rather than assumed constant.
 */
export function roundTripCostPct(market: Market, signals?: Pick<Signals, "atrPct" | "dollarVolume">): number {
  const fixed = market === "UK" ? 0.5 : 0.15 * 2;
  if (!signals) return fixed + (market === "UK" ? 0.2 : 0.1);

  const liquidityFactor = clamp(Math.log10(1e9 / Math.max(1e6, signals.dollarVolume)) * 0.06, 0, 0.35);
  const volFactor = clamp(signals.atrPct * 0.02, 0.01, 0.2);
  const spreadPerSide = clamp(0.015 + liquidityFactor + volFactor, 0.02, 0.4);
  return fixed + spreadPerSide * 2;
}

/**
 * Extra return demanded on top of costs before the engine will act. Selling at the open means
 * crossing a wider auction spread, so this is deliberately non-zero even when costs are tiny.
 */
export const OPENING_AUCTION_SLIPPAGE_PCT = 0.05;

export const breakEvenPct = (market: Market, signals?: Pick<Signals, "atrPct" | "dollarVolume">) =>
  roundTripCostPct(market, signals) + OPENING_AUCTION_SLIPPAGE_PCT;
