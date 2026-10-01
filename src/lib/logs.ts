import { and, desc, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { LogLevel } from "./log";

const { eventLog } = schema;

export interface LogQuery {
  /** Case-insensitive text found in the message or the source. */
  q?: string;
  levels?: LogLevel[];
  sources?: string[];
  runId?: number;
  /** Inclusive time bounds, in epoch milliseconds. */
  from?: number;
  to?: number;
  /** Return rows older than this id (keyset pagination: stable while new rows keep arriving). */
  before?: number;
  limit?: number;
}

export interface LogRow {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  runId: number | null;
  detail?: Record<string, unknown> | null;
}

export const MAX_PAGE = 1000;
export const MAX_EXPORT = 20_000;

const LEVELS: LogLevel[] = ["info", "warn", "error"];

/** LIKE treats % and _ as wildcards; a search for "50%" should find "50%", not everything. */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function conditions(f: LogQuery): SQL[] {
  const where: SQL[] = [];
  const q = f.q?.trim();
  if (q) {
    const p = likePattern(q);
    where.push(sql`(${eventLog.message} LIKE ${p} ESCAPE '\\' OR ${eventLog.source} LIKE ${p} ESCAPE '\\')`);
  }
  if (f.levels?.length) where.push(inArray(eventLog.level, f.levels));
  if (f.sources?.length) where.push(inArray(eventLog.source, f.sources));
  if (f.runId !== undefined) where.push(sql`${eventLog.runId} = ${f.runId}`);
  if (f.from !== undefined) where.push(gte(eventLog.ts, new Date(f.from)));
  if (f.to !== undefined) where.push(lte(eventLog.ts, new Date(f.to)));
  return where;
}

export async function queryLogs(f: LogQuery): Promise<{ rows: LogRow[]; total: number; nextBefore: number | null }> {
  const db = getDb();
  const limit = Math.max(1, Math.min(f.limit ?? 200, MAX_EXPORT));
  const base = conditions(f);
  const page = f.before !== undefined ? [...base, lt(eventLog.id, f.before)] : base;

  const rows = await db
    .select()
    .from(eventLog)
    .where(page.length ? and(...page) : undefined)
    .orderBy(desc(eventLog.id))
    .limit(limit + 1);

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(eventLog)
    .where(base.length ? and(...base) : undefined);

  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  return {
    rows: slice.map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      level: r.level,
      source: r.source,
      message: r.message,
      runId: r.runId,
      detail: r.detail as Record<string, unknown> | null,
    })),
    total: Number(n),
    nextBefore: more ? slice[slice.length - 1].id : null,
  };
}

export async function logSources(): Promise<string[]> {
  const rows = await getDb().selectDistinct({ source: eventLog.source }).from(eventLog);
  return rows.map((r) => r.source).sort();
}

export function parseLevels(raw: string | null): LogLevel[] | undefined {
  const out = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is LogLevel => (LEVELS as string[]).includes(s));
  return out.length ? out : undefined;
}

/** One CSV field: quoted when needed, and neutralised if a spreadsheet would read it as a formula. */
export function csvField(v: string | number | null): string {
  if (v === null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const londonTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Oldest first, so the file reads as a story from top to bottom. */
export function logsToCsv(rows: LogRow[]): string {
  const header = "id,time_utc,time_london,level,source,run_id,message,detail_json";
  const lines = [...rows].reverse().map((r) =>
    [r.id, new Date(r.ts).toISOString(), londonTime.format(new Date(r.ts)), r.level, r.source, r.runId, r.message, r.detail ? JSON.stringify(r.detail) : ""]
      .map(csvField)
      .join(","),
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}
