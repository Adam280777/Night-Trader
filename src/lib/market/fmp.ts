import { z } from "zod";
import { getEnvConfig } from "../config";
import { getKv, setKv } from "../kv";

const BASE_URL = "https://financialmodelingprep.com";
const REQUEST_TIMEOUT_MS = 8_000;
const CALENDAR_TTL_MS = 15 * 60_000;
const calendarLoads = new Map<string, Promise<unknown>>();

export interface FmpStats {
  calls: number;
  failures: number;
  timeouts: number;
  totalMs: number;
  lastError: string | null;
}

const stats: FmpStats = { calls: 0, failures: 0, timeouts: 0, totalMs: 0, lastError: null };

export function fmpStats(reset = false): FmpStats {
  const copy = { ...stats };
  if (reset) Object.assign(stats, { calls: 0, failures: 0, timeouts: 0, totalMs: 0, lastError: null });
  return copy;
}

const QuoteRowSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  price: z.number().positive(),
  changePercentage: z.number().optional(),
  change: z.number().optional(),
  volume: z.number().nonnegative().optional(),
  averageVolume: z.number().nonnegative().optional(),
  marketCap: z.number().nonnegative().optional(),
  timestamp: z.number().int().positive(),
  exchange: z.string().optional(),
});

const EarningsRowSchema = z.object({
  symbol: z.string(),
  date: z.string(),
  time: z.string().nullable().optional(),
});

const EconomicRowSchema = z.object({
  date: z.string(),
  country: z.string().optional(),
  event: z.string(),
  impact: z.string().optional(),
});

export type FmpQuote = z.infer<typeof QuoteRowSchema>;
export type FmpEconomicEvent = z.infer<typeof EconomicRowSchema>;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string): Date | null {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized.endsWith("Z") || /[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function parseFmpQuoteResponse(value: unknown): FmpQuote[] {
  return z.array(QuoteRowSchema).parse(value);
}

export function parseFmpEarningsResponse(value: unknown): Array<{ symbol: string; date: Date; time: string | null }> {
  return z.array(EarningsRowSchema).parse(value).flatMap((row) => {
    const date = parseDate(row.date);
    return date ? [{ symbol: row.symbol, date, time: row.time ?? null }] : [];
  });
}

export function parseFmpEconomicResponse(value: unknown): Array<FmpEconomicEvent & { at: Date }> {
  return z.array(EconomicRowSchema).parse(value).flatMap((row) => {
    const at = parseDate(row.date);
    return at ? [{ ...row, at }] : [];
  });
}

export class FmpClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("FMP API key is required");
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apikey", this.apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();
    stats.calls++;
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160).replaceAll(this.apiKey, "[redacted]");
        throw new Error(`FMP request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      return await response.json();
    } catch (error) {
      stats.failures++;
      if (error instanceof Error && error.name === "AbortError") {
        stats.timeouts++;
        stats.lastError = `request timed out after ${REQUEST_TIMEOUT_MS}ms`;
        throw new Error(`FMP request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      stats.lastError = String(error).replaceAll(this.apiKey, "[redacted]").slice(0, 180);
      throw error;
    } finally {
      clearTimeout(timeout);
      stats.totalMs += Date.now() - started;
    }
  }

  async quote(symbol: string): Promise<FmpQuote | null> {
    const rows = parseFmpQuoteResponse(await this.request("/stable/quote", { symbol }));
    return rows[0] ?? null;
  }

  async earnings(from: Date, to: Date) {
    return parseFmpEarningsResponse(await this.request("/stable/earnings-calendar", { from: ymd(from), to: ymd(to) }));
  }

  async economicEvents(from: Date, to: Date) {
    return parseFmpEconomicResponse(await this.request("/stable/economic-calendar", { from: ymd(from), to: ymd(to) }));
  }
}

export async function tryFmpClient(): Promise<FmpClient | null> {
  const { fmpKey } = await getEnvConfig();
  return fmpKey ? new FmpClient(fmpKey) : null;
}

async function cachedCalendar<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = await getKv<T>(key);
  if (cached && Date.now() - cached.updatedAt < CALENDAR_TTL_MS) return cached.value;
  const active = calendarLoads.get(key);
  if (active) return active as Promise<T>;
  const promise = (async () => {
    const value = await load();
    await setKv(key, value);
    return value;
  })();
  calendarLoads.set(key, promise);
  try {
    return await promise;
  } finally {
    calendarLoads.delete(key);
  }
}

export async function getFmpEarnings(symbol: string, now = new Date()): Promise<Date | null> {
  const client = await tryFmpClient();
  if (!client) return null;
  const to = new Date(now.getTime() + 7 * 86_400_000);
  const rows = await cachedCalendar<Array<{ symbol: string; date: Date | string; time: string | null }>>(
    `fmp:earnings:${ymd(now)}`,
    () => client.earnings(now, to),
  );
  const date = rows.find((row) => row.symbol.toUpperCase() === symbol.toUpperCase())?.date;
  return date ? new Date(date) : null;
}

export async function getHighImpactEconomicEvents(now = new Date(), hours = 36) {
  const client = await tryFmpClient();
  if (!client) return [];
  const from = new Date(now.getTime() - 6 * 3_600_000);
  const to = new Date(now.getTime() + hours * 3_600_000);
  const calendarTo = new Date(now.getTime() + 48 * 3_600_000);
  const rows = await cachedCalendar<Array<FmpEconomicEvent & { at: Date | string }>>(
    `fmp:economics:${ymd(now)}`,
    () => client.economicEvents(from, calendarTo),
  );
  return rows.map((row) => ({ ...row, at: new Date(row.at) })).filter((row) => {
    const impact = row.impact?.toLowerCase() ?? "";
    const country = row.country?.toLowerCase() ?? "";
    return row.at >= from && row.at <= to && (!country || country === "us" || country === "united states") && impact === "high";
  });
}
