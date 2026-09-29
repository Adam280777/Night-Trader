import { DateTime } from "luxon";
import type { T212Client, TradableInstrument } from "../t212/client";
import { getExchangesCached, getInstrumentsCached, marketOf, type Market } from "../t212/instruments";
import { scheduleFor, type Session } from "./calendar";

export const MARKET_TZ: Record<Market, string> = { US: "America/New_York", UK: "Europe/London" };

const scheduleIdCache = new Map<string, number>();

/** The working schedule most instruments of this market use (i.e. the main exchange session). */
function mainScheduleId(client: T212Client, instruments: TradableInstrument[], market: Market): number | null {
  const key = `${client.env}:${market}`;
  const hit = scheduleIdCache.get(key);
  if (hit) return hit;
  const counts = new Map<number, number>();
  for (const i of instruments) {
    if (i.type !== "STOCK" || marketOf(i) !== market) continue;
    counts.set(i.workingScheduleId, (counts.get(i.workingScheduleId) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) scheduleIdCache.set(key, best);
  return best ?? null;
}

export async function getMarketSessions(client: T212Client, market: Market): Promise<Session[]> {
  const [instruments, exchanges] = await Promise.all([getInstrumentsCached(client), getExchangesCached(client)]);
  const id = mainScheduleId(client, instruments, market);
  if (!id) throw new Error(`No working schedule found for ${market}`);
  const sched = scheduleFor(exchanges, id);
  if (!sched) throw new Error(`Schedule ${id} for ${market} not in exchanges metadata`);
  return sched.sessions;
}

/** YYYY-MM-DD of `d` in the market's own time zone. */
export function tradingDateOf(market: Market, d: Date): string {
  return DateTime.fromJSDate(d, { zone: MARKET_TZ[market] }).toFormat("yyyy-LL-dd");
}
