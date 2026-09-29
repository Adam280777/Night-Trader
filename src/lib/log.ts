import { getDb, schema } from "./db";

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, source: string, message: string, runId?: number) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${source}: ${message}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  try {
    getDb().insert(schema.eventLog).values({ level, source, message, runId: runId ?? null }).run();
  } catch {
    /* logging must never crash the caller */
  }
}
