import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnvConfig } from "./config";
import { T212Client } from "./t212/client";

export interface AccountState {
  totalValue: number;
  availableCash: number;
  currency: string;
  source: "t212" | "virtual";
}

const VIRTUAL_START = 1000;

/** Real account summary when keys are configured; otherwise a virtual GBP bankroll so dry-run still works. */
export async function getAccountState(client: T212Client | null): Promise<AccountState> {
  if (client) {
    const s = await client.getAccountSummary();
    return { totalValue: s.totalValue, availableCash: s.cash.availableToTrade, currency: s.currency, source: "t212" };
  }
  const closed = await getDb().select({ pnl: schema.trades.pnl }).from(schema.trades).where(eq(schema.trades.status, "closed"));
  const total = VIRTUAL_START + closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  return { totalValue: total, availableCash: total, currency: "GBP", source: "virtual" };
}

export async function tryClient(): Promise<T212Client | null> {
  const c = await getEnvConfig();
  return c.t212Key && c.t212Secret ? new T212Client(c.t212Env, c.t212Key, c.t212Secret) : null;
}

/** Realised P&L over rolling windows as a fraction of current account value (negative = loss). */
export async function pnlWindows(totalValue: number, now = new Date()) {
  const db = getDb();
  const since = async (ms: number) =>
    (
      await db
        .select({ pnl: schema.trades.pnl })
        .from(schema.trades)
        .where(and(eq(schema.trades.status, "closed"), gte(schema.trades.exitAt, new Date(now.getTime() - ms))))
    ).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const base = Math.max(1, totalValue);
  return { dayPct: (await since(24 * 3_600_000)) / base, weekPct: (await since(7 * 24 * 3_600_000)) / base };
}

export async function openTrade() {
  const [t] = await getDb().select().from(schema.trades).where(eq(schema.trades.status, "open")).limit(1);
  return t ?? null;
}
