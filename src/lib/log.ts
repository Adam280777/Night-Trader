import { getDb, schema } from "./db";

export type LogLevel = "info" | "warn" | "error";

export async function log(level: LogLevel, source: string, message: string, runId?: number): Promise<void> {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${source}: ${message}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  try {
    await getDb().insert(schema.eventLog).values({ level, source, message, runId: runId ?? null });
  } catch {
    /* logging must never crash the caller */
  }
}
