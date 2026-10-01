import { lt, like, and, or } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { OpsSettings } from "./config";
import { log } from "./log";

const DAY = 86_400_000;

export interface RetentionResult {
  logs: number;
  jobs: number;
  equity: number;
  kv: number;
}

/**
 * Trim the tables that only ever grow. Each cut-off comes from Settings > Operations; the trade
 * history, decisions, candidates and the model itself are never touched here.
 */
export async function pruneOperationalData(ops: OpsSettings, now = Date.now()): Promise<RetentionResult> {
  const db = getDb();
  const count = (r: { rowsAffected?: number }) => r.rowsAffected ?? 0;

  const logs = count(await db.delete(schema.eventLog).where(lt(schema.eventLog.ts, new Date(now - ops.logRetentionDays * DAY))));
  const jobs = count(await db.delete(schema.jobRuns).where(lt(schema.jobRuns.startedAt, new Date(now - ops.jobRetentionDays * DAY))));
  const equity = count(await db.delete(schema.equitySnapshots).where(lt(schema.equitySnapshots.ts, new Date(now - ops.equityRetentionDays * DAY))));
  // Per-run market context and failure-dedupe markers are only useful for a few weeks.
  const kv = count(
    await db.delete(schema.kv).where(and(or(like(schema.kv.key, "mctx:%"), like(schema.kv.key, "alert:%"), like(schema.kv.key, "jobfail:%")), lt(schema.kv.updatedAt, now - 45 * DAY))),
  );

  const total = logs + jobs + equity + kv;
  if (total > 0) await log("info", "retention", `Pruned ${logs} log line(s), ${jobs} job record(s), ${equity} equity snapshot(s) and ${kv} stale cache entr${kv === 1 ? "y" : "ies"}.`);
  return { logs, jobs, equity, kv };
}
