import { eq, lt } from "drizzle-orm";
import { getDb, schema } from "./db";

/** True if this caller now holds the lease. A crashed holder's lease simply expires. */
export async function acquireLock(name: string, ttlMs: number): Promise<boolean> {
  const now = Date.now();
  const rows = await getDb()
    .insert(schema.locks)
    .values({ name, until: now + ttlMs })
    .onConflictDoUpdate({ target: schema.locks.name, set: { until: now + ttlMs }, setWhere: lt(schema.locks.until, now) })
    .returning({ name: schema.locks.name });
  return rows.length > 0;
}

export async function releaseLock(name: string): Promise<void> {
  await getDb().update(schema.locks).set({ until: 0 }).where(eq(schema.locks.name, name));
}

/** Runs fn only if the lease is free. Returns false when someone else holds it. */
export async function withLock(name: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
  if (!(await acquireLock(name, ttlMs))) return false;
  try {
    await fn();
  } finally {
    await releaseLock(name).catch(() => {});
  }
  return true;
}
