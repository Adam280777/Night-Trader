import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const g = globalThis as unknown as { __db?: Db };

/** Singleton per process; survives Next.js dev hot reloads. */
export function getDb(): Db {
  if (g.__db) return g.__db;
  const file = path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH ?? "./data/trader.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL"); // web app + worker share the file
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(/*turbopackIgnore: true*/ "./drizzle") });
  g.__db = db;
  return db;
}

export { schema };
