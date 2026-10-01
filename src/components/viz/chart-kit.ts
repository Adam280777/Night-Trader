// Shared recharts styling + formatters so every chart looks the same.
export const GRID = "var(--border)";
export const AXIS = { fontSize: 11, fill: "var(--muted)" } as const;

export const TOOLTIP = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--fg)", boxShadow: "var(--pop-shadow)" },
  labelStyle: { color: "var(--muted)", marginBottom: 2 },
  itemStyle: { color: "var(--fg)", padding: 0 },
  cursor: { stroke: "var(--border)", fill: "var(--surface-2)", fillOpacity: 0.6 },
} as const;

const TZ = "Europe/London";

/** X-axis tick for a timestamp: includes the time when the visible span is short. */
export function fmtTick(ts: number, spanMs: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  if (spanMs <= 36 * 3600_000) return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(d);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TZ }).format(d);
}

export function fmtDateTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(new Date(ts));
}

export function spanOf(values: number[]): number {
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}
