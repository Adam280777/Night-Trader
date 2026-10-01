import { and, eq, gte } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnvConfig } from "./config";
import { getKv, setKv } from "./kv";
import { withLock } from "./locks";
import { T212Client } from "./t212/client";

export interface AccountState {
  totalValue: number;
  availableCash: number;
  currency: string;
  source: "t212" | "virtual";
}

const VIRTUAL_START = 1000;
const DASHBOARD_ACCOUNT_KEY = "account:dashboard";
const DASHBOARD_ACCOUNT_FRESH_MS = 30_000;
const DASHBOARD_ACCOUNT_STALE_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * A short shared cache keeps clustered page refreshes from queueing behind Trading 212's
 * account-summary rate limit. Trading decisions never use this function; they always fetch fresh.
 */
export async function getDashboardAccountState(client: T212Client | null, now = Date.now()): Promise<AccountState> {
  if (!client) return getAccountState(null);

  let cached = await getKv<AccountState>(DASHBOARD_ACCOUNT_KEY);
  if (cached && now - cached.updatedAt <= DASHBOARD_ACCOUNT_FRESH_MS) return cached.value;

  let loaded: AccountState | null = null;
  const acquired = await withLock("dashboard-account", 70_000, async () => {
    const latest = await getKv<AccountState>(DASHBOARD_ACCOUNT_KEY);
    if (latest && Date.now() - latest.updatedAt <= DASHBOARD_ACCOUNT_FRESH_MS) {
      loaded = latest.value;
      return;
    }
    loaded = await getAccountState(client);
    await setKv(DASHBOARD_ACCOUNT_KEY, loaded);
  });
  if (acquired && loaded) return loaded;

  // Another request owns the refresh. Give it enough time to clear the normal 5.2-second API
  // throttle, then use its result instead of starting another broker request.
  for (let attempt = 0; attempt < 24; attempt++) {
    await sleep(250);
    cached = await getKv<AccountState>(DASHBOARD_ACCOUNT_KEY);
    if (cached && Date.now() - cached.updatedAt <= DASHBOARD_ACCOUNT_FRESH_MS) return cached.value;
  }
  if (cached && Date.now() - cached.updatedAt <= DASHBOARD_ACCOUNT_STALE_MS) return cached.value;
  throw new Error("Trading 212 account summary is already refreshing; retry shortly.");
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
