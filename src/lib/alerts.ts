import { createHash } from "node:crypto";
import { getKv, setKv } from "./kv";

export interface OperationalAlert {
  level: "warn" | "critical";
  source: string;
  message: string;
  runId?: number;
  detail?: Record<string, unknown>;
  dedupeKey?: string;
}

const DEDUPE_MS = 30 * 60_000;

/**
 * Sends a compact JSON alert to an operator-owned webhook. The event log remains authoritative;
 * alert delivery is deliberately best-effort and can never fail a trading or recovery path.
 */
export async function sendOperationalAlert(alert: OperationalAlert): Promise<boolean> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return false;

  const normalised = alert.message.toLowerCase().replace(/\b\d+(?:\.\d+)?\b/g, "#").replace(/\s+/g, " ").trim();
  const digest = createHash("sha256").update(`${alert.level}:${alert.source}:${alert.dedupeKey ?? normalised}`).digest("hex").slice(0, 20);
  const key = `alert:${digest}`;
  const now = Date.now();
  try {
    const previous = await getKv<number>(key);
    if (previous && now - previous.value < DEDUPE_MS) return false;
    const summary = `[${alert.level.toUpperCase()}] ${alert.source}${alert.runId ? ` run #${alert.runId}` : ""}: ${alert.message}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: summary,
        content: summary,
        event: {
          level: alert.level,
          source: alert.source,
          message: alert.message,
          runId: alert.runId ?? null,
          detail: alert.detail ?? null,
          occurredAt: new Date(now).toISOString(),
        },
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);
    await setKv(key, now);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ALERT delivery failed: ${String(error).slice(0, 300)}`);
    return false;
  }
}
