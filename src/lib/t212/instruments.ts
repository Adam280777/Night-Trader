import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { T212Client, type Exchange, type TradableInstrument } from "./client";

async function cached<T>(name: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const db = getDb();
  const [row] = await db.select().from(schema.kv).where(eq(schema.kv.key, name));
  if (row && Date.now() - row.updatedAt < ttlMs) return JSON.parse(row.value) as T;
  try {
    const fresh = await fetcher();
    const value = JSON.stringify(fresh);
    await db.insert(schema.kv).values({ key: name, value, updatedAt: Date.now() }).onConflictDoUpdate({ target: schema.kv.key, set: { value, updatedAt: Date.now() } });
    return fresh;
  } catch (err) {
    // Rate limited or offline: a stale copy is better than nothing.
    if (row) return JSON.parse(row.value) as T;
    throw err;
  }
}

const HOUR = 3_600_000;

/** Only US and UK stocks are ever traded, so only those are stored. */
export const getInstrumentsCached = (c: T212Client) =>
  cached<TradableInstrument[]>(`instruments-${c.env}`, 12 * HOUR, async () => (await c.getInstruments()).filter((i) => marketOf(i) !== null));

export const getExchangesCached = (c: T212Client) =>
  cached<Exchange[]>(`exchanges-${c.env}`, 1 * HOUR, () => c.getExchanges());

export type Market = "US" | "UK";

/** T212 ticker convention: AAPL_US_EQ (US), VODl_EQ (LSE, lower-case l suffix). */
export function marketOf(t: Pick<TradableInstrument, "ticker" | "currencyCode">): Market | null {
  if (/_US_EQ$/.test(t.ticker)) return "US";
  if (/l_EQ$/.test(t.ticker) && (t.currencyCode === "GBX" || t.currencyCode === "GBP")) return "UK";
  return null;
}
