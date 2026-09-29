import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";

export async function getKv<T>(key: string): Promise<{ value: T; updatedAt: number } | null> {
  const [row] = await getDb().select().from(schema.kv).where(eq(schema.kv.key, key));
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export async function setKv(key: string, value: unknown): Promise<void> {
  const now = Date.now();
  const v = JSON.stringify(value);
  await getDb().insert(schema.kv).values({ key, value: v, updatedAt: now }).onConflictDoUpdate({ target: schema.kv.key, set: { value: v, updatedAt: now } });
}
