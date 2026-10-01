import { getDb, schema } from "./db";
import { sendOperationalAlert } from "./alerts";

export type LogLevel = "info" | "warn" | "error";

/** Structured context stored beside a log line. Keep it small and free of secrets. */
export type LogDetail = Record<string, unknown>;

/** Reduce any thrown value to something safe and compact to store. */
export function errorDetail(err: unknown): LogDetail {
  if (err instanceof Error) {
    return { name: err.name, message: err.message.slice(0, 500), stack: err.stack?.split("\n").slice(0, 6).join("\n") };
  }
  return { message: String(err).slice(0, 500) };
}

export async function log(level: LogLevel, source: string, message: string, runId?: number, detail?: LogDetail): Promise<void> {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${source}: ${message}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  try {
    await getDb()
      .insert(schema.eventLog)
      .values({ level, source, message, runId: runId ?? null, detail: detail ?? null });
  } catch {
    /* logging must never crash the caller */
  }
  if (level === "error") {
    await sendOperationalAlert({ level: "critical", source, message, runId, detail });
  }
}
