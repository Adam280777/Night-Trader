import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = LibSQLDatabase<typeof schema>;

const g = globalThis as unknown as { __db?: Db; __migrated?: Promise<void> };

/** Turso (hosted) when TURSO_DATABASE_URL is set, otherwise a local SQLite file. */
export function getDb(): Db {
  if (g.__db) return g.__db;
  const remote = process.env.TURSO_DATABASE_URL || process.env.STORAGE_TURSO_DATABASE_URL;
  let client;
  if (remote) {
    client = createClient({ url: remote, authToken: process.env.TURSO_AUTH_TOKEN || process.env.STORAGE_TURSO_AUTH_TOKEN });
  } else {
    if (process.env.VERCEL) throw new Error("TURSO_DATABASE_URL is not set");
    const file = path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH ?? "./data/trader.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    client = createClient({ url: `file:${file}` });
  }
  g.__db = drizzle(client, { schema });
  return g.__db;
}

/** Applies pending migrations once per process. On Vercel the build step (scripts/migrate.ts) applies them; the .sql files aren't bundled into functions. */
export function ensureMigrated(opts: { force?: boolean } = {}): Promise<void> {
  const folder = path.resolve(/*turbopackIgnore: true*/ "./drizzle");
  if (process.env.VERCEL && !opts.force) return Promise.resolve();
  return (g.__migrated ??= migrate(getDb(), { migrationsFolder: folder }).catch((e) => {
    g.__migrated = undefined;
    throw e;
  }));
}

export { schema };
