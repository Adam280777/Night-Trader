import { getEnvConfig } from "../config";

export type T212Env = "demo" | "live";

export interface AccountSummary {
  id: number;
  currency: string;
  totalValue: number;
  cash: { availableToTrade: number; inPies: number; reservedForOrders: number };
  investments: {
    currentValue: number;
    totalCost: number;
    realizedProfitLoss: number;
    unrealizedProfitLoss: number;
  };
}

export interface Position {
  averagePricePaid: number;
  currentPrice: number;
  createdAt: string;
  quantity: number;
  quantityAvailableForTrading: number;
  quantityInPies: number;
  instrument: { ticker: string; name: string; isin: string; currency: string };
  walletImpact: {
    currency: string;
    currentValue: number;
    totalCost: number;
    unrealizedProfitLoss: number;
    fxImpact?: number;
  };
}

export type OrderStatus =
  | "LOCAL"
  | "UNCONFIRMED"
  | "CONFIRMED"
  | "NEW"
  | "CANCELLING"
  | "CANCELLED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "REPLACING"
  | "REPLACED";

export interface T212Order {
  id: number;
  ticker: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "STOP" | "MARKET" | "STOP_LIMIT";
  status: OrderStatus;
  quantity?: number;
  filledQuantity?: number;
  filledValue?: number;
  createdAt: string;
  extendedHours?: boolean;
  instrument?: { ticker: string; name: string; isin: string; currency: string };
}

export interface HistoricalOrder {
  order: T212Order;
  fill?: {
    id: number;
    filledAt: string;
    price: number;
    quantity: number;
    walletImpact?: {
      currency: string;
      fxRate?: number;
      netValue?: number;
      realisedProfitLoss?: number;
      taxes?: { name?: string; quantity?: number; currency?: string }[];
    };
  };
}

export interface TradableInstrument {
  ticker: string;
  type: string;
  name: string;
  shortName?: string;
  isin?: string;
  currencyCode: string;
  extendedHours?: boolean;
  maxOpenQuantity?: number;
  workingScheduleId: number;
  addedOn?: string;
}

export interface TimeEvent {
  date: string;
  type:
    | "OPEN"
    | "CLOSE"
    | "BREAK_START"
    | "BREAK_END"
    | "PRE_MARKET_OPEN"
    | "AFTER_HOURS_OPEN"
    | "AFTER_HOURS_CLOSE"
    | "OVERNIGHT_OPEN";
}
export interface Exchange {
  id: number;
  name: string;
  workingSchedules: { id: number; timeEvents: TimeEvent[] }[];
}

export class T212Error extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** Thrown when a POST may or may not have been executed. Callers MUST reconcile, never retry. */
export class OrderOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Documented minimum spacing per endpoint (ms), with a small safety margin.
const MIN_INTERVAL_MS: Record<string, number> = {
  "GET /equity/account/summary": 5_200,
  "GET /equity/positions": 1_100,
  "GET /equity/metadata/instruments": 51_000,
  "GET /equity/metadata/exchanges": 31_000,
  "GET /equity/orders": 5_200,
  "GET /equity/history/orders": 10_500,
  "POST /equity/orders/market": 1_300, // 50/min
  "GET /equity/orders/{id}": 1_100,
};

const lastCall = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(key: string) {
  const gap = MIN_INTERVAL_MS[key] ?? 1_000;
  const wait = (lastCall.get(key) ?? 0) + gap - Date.now();
  // Reserve the slot immediately so concurrent callers queue behind each other.
  lastCall.set(key, Math.max(Date.now(), (lastCall.get(key) ?? 0) + gap));
  if (wait > 0) await sleep(wait);
}

export class T212Client {
  private base: string;
  private auth: string;

  constructor(
    public readonly env: T212Env,
    key: string,
    secret: string,
  ) {
    this.base = `https://${env}.trading212.com/api/v0`;
    this.auth = "Basic " + Buffer.from(`${key}:${secret}`, "utf8").toString("base64");
  }

  static async fromEnv(): Promise<T212Client> {
    const c = await getEnvConfig();
    if (!c.t212Key || !c.t212Secret) throw new Error("Trading 212 API key/secret not set (add them in Settings)");
    return new T212Client(c.t212Env, c.t212Key, c.t212Secret);
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; rateKey?: string } = {},
  ): Promise<T> {
    const rateKey = opts.rateKey ?? `${method} ${path}`;
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const maxAttempts = method === "GET" ? 3 : 1; // never auto-retry non-idempotent calls

    for (let attempt = 1; ; attempt++) {
      await throttle(rateKey);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: this.auth,
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        if (method === "POST") {
          throw new OrderOutcomeUnknownError(`Network error/timeout sending ${path}: ${String(err)}`);
        }
        if (attempt < maxAttempts) continue;
        throw err;
      }

      if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

      const body = await res.json().catch(() => undefined);
      if (method === "POST" && res.status === 408) {
        throw new OrderOutcomeUnknownError(`T212 timed out (408) on ${path}`);
      }
      if (res.status === 429 && attempt < maxAttempts) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const waitMs = reset ? Math.max(1_000, reset * 1000 - Date.now()) : 5_000;
        await sleep(Math.min(waitMs, 60_000));
        continue;
      }
      throw new T212Error(`T212 ${method} ${path} -> ${res.status}`, res.status, body);
    }
  }

  getAccountSummary() {
    return this.request<AccountSummary>("GET", "/equity/account/summary");
  }
  getPositions(ticker?: string) {
    return this.request<Position[]>("GET", "/equity/positions", { query: { ticker } });
  }
  getInstruments() {
    return this.request<TradableInstrument[]>("GET", "/equity/metadata/instruments");
  }
  getExchanges() {
    return this.request<Exchange[]>("GET", "/equity/metadata/exchanges");
  }
  getPendingOrders() {
    return this.request<T212Order[]>("GET", "/equity/orders");
  }
  getOrder(id: number) {
    return this.request<T212Order>("GET", `/equity/orders/${id}`, { rateKey: "GET /equity/orders/{id}" });
  }
  cancelOrder(id: number) {
    return this.request<void>("DELETE", `/equity/orders/${id}`, { rateKey: "DELETE /equity/orders/{id}" });
  }

  /** Most recent historical orders first. Follows nextPagePath up to `maxPages`. */
  async getHistoricalOrders(maxPages = 1): Promise<HistoricalOrder[]> {
    const out: HistoricalOrder[] = [];
    let page = await this.request<{ items: HistoricalOrder[]; nextPagePath: string | null }>(
      "GET",
      "/equity/history/orders",
      { query: { limit: 50 } },
    );
    out.push(...page.items);
    for (let i = 1; i < maxPages && page.nextPagePath; i++) {
      // nextPagePath is a full path incl. /api/v0; strip the prefix our base already has.
      const next = page.nextPagePath.replace(/^\/api\/v0/, "");
      const [p, qs] = next.split("?");
      const query = Object.fromEntries(new URLSearchParams(qs ?? ""));
      page = await this.request("GET", p, { query, rateKey: "GET /equity/history/orders" });
      out.push(...page.items);
    }
    return out;
  }

  /** quantity > 0 buys, < 0 sells. Market orders execute in the account currency. */
  placeMarketOrder(ticker: string, quantity: number, extendedHours = false) {
    return this.request<T212Order>("POST", "/equity/orders/market", {
      body: { ticker, quantity, extendedHours },
    });
  }
}
