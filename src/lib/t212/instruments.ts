import fs from "node:fs";
import path from "node:path";
import { T212Client, type Exchange, type TradableInstrument } from "./client";

const dir = () => path.resolve("./data/cache");

async function cached<T>(name: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const file = path.join(dir(), `${name}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < ttlMs) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    /* miss */
  }
  try {
    const fresh = await fetcher();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fresh));
    return fresh;
  } catch (err) {
    // Rate limited or offline: a stale copy is better than nothing.
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    throw err;
  }
}

const HOUR = 3_600_000;

export const getInstrumentsCached = (c: T212Client) =>
  cached<TradableInstrument[]>(`instruments-${c.env}`, 12 * HOUR, () => c.getInstruments());

export const getExchangesCached = (c: T212Client) =>
  cached<Exchange[]>(`exchanges-${c.env}`, 1 * HOUR, () => c.getExchanges());

export type Market = "US" | "UK";

/** T212 ticker convention: AAPL_US_EQ (US), VODl_EQ (LSE, lower-case l suffix). */
export function marketOf(t: Pick<TradableInstrument, "ticker" | "currencyCode">): Market | null {
  if (/_US_EQ$/.test(t.ticker)) return "US";
  if (/l_EQ$/.test(t.ticker) && (t.currencyCode === "GBX" || t.currencyCode === "GBP")) return "UK";
  return null;
}
