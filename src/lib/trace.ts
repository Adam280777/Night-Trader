import { getDb, schema } from "./db";
import { getKv, setKv } from "./kv";
import { errorDetail, log, type LogDetail } from "./log";
import { yahooStats, type YahooStats } from "./market/data";

export type Traced<T> = { ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number };

export interface TraceOptions<T> {
  runId?: number;
  /** Extra structured context stored with the job row, derived from the result. */
  detail?: (value: T) => LogDetail | undefined;
  /** Return false for results that did no real work (idle polls), so they leave no row behind. */
  record?: (value: T) => boolean;
  /** Warn when the job takes longer than this. */
  slowMs?: number;
  /** Also log a line on success. */
  verbose?: boolean;
  /** Short human summary for the verbose line. */
  summary?: (value: T) => string;
}

const REPEAT_ERROR_MS = 30 * 60_000;

/**
 * Run one background job, time it, keep a row for the System page, and turn any failure into a single
 * de-duplicated error entry with a stack trace. Never throws: callers keep going with the next job.
 */
export async function traced<T>(job: string, fn: () => Promise<T>, opts: TraceOptions<T> = {}): Promise<Traced<T>> {
  const startedAt = Date.now();
  const before = yahooStats();
  try {
    const value = await fn();
    const ms = Date.now() - startedAt;
    if (opts.record?.(value) !== false) {
      await store(job, startedAt, ms, true, null, { ...opts.detail?.(value), yahoo: compactYahoo(before) });
      if (opts.slowMs && ms > opts.slowMs) {
        await log("warn", "trace", `${job} took ${(ms / 1000).toFixed(0)}s (slow threshold ${(opts.slowMs / 1000).toFixed(0)}s).`, opts.runId, {
          job,
          ms,
          yahoo: compactYahoo(before),
        });
      } else if (opts.verbose) {
        await log("info", "trace", `${job} finished in ${(ms / 1000).toFixed(1)}s${opts.summary ? `: ${opts.summary(value)}` : ""}`, opts.runId, { job, ms });
      }
    }
    return { ok: true, value, ms };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const message = String(error instanceof Error ? error.message : error).slice(0, 300);
    await store(job, startedAt, ms, false, message, { yahoo: compactYahoo(before) });
    await reportFailure(job, message, error, ms, opts.runId);
    return { ok: false, error, ms };
  }
}

function compactYahoo(before: YahooStats): LogDetail | undefined {
  const now = yahooStats();
  const calls = now.calls - before.calls;
  if (calls <= 0) return undefined;
  const failures = now.failures - before.failures;
  return {
    calls,
    failures,
    timeouts: now.timeouts - before.timeouts,
    avgMs: Math.round((now.totalMs - before.totalMs) / calls),
    lastError: failures > 0 ? now.lastError : null,
  };
}

async function store(job: string, startedAt: number, durationMs: number, ok: boolean, error: string | null, detail: LogDetail) {
  try {
    const clean = Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined));
    await getDb()
      .insert(schema.jobRuns)
      .values({ job, startedAt: new Date(startedAt), durationMs, ok, error, detail: Object.keys(clean).length ? clean : null });
  } catch {
    /* telemetry must never break the job */
  }
}

/** The same failure every minute would bury the log, so repeat it at most once per half hour. */
async function reportFailure(job: string, message: string, error: unknown, ms: number, runId?: number) {
  const key = `jobfail:${job}`;
  const now = Date.now();
  try {
    const prev = await getKv<{ message: string; at: number; suppressed: number }>(key);
    if (prev && prev.value.message === message && now - prev.value.at < REPEAT_ERROR_MS) {
      await setKv(key, { ...prev.value, suppressed: prev.value.suppressed + 1 });
      return;
    }
    const suppressed = prev?.value.suppressed ?? 0;
    await setKv(key, { message, at: now, suppressed: 0 });
    await log("error", "trace", `${job} failed after ${(ms / 1000).toFixed(1)}s: ${message}${suppressed ? ` (${suppressed} identical failure(s) hidden since the last report)` : ""}`, runId, {
      job,
      ms,
      ...errorDetail(error),
    });
  } catch {
    await log("error", "trace", `${job} failed: ${message}`, runId, errorDetail(error));
  }
}
