import type { ReactNode } from "react";
import type { Tone } from "@/lib/format";

/** Maps a semantic tone to a theme CSS colour. */
export const TONE_COLOR: Record<Tone, string> = {
  good: "var(--accent)",
  bad: "var(--danger)",
  warn: "var(--warn)",
  info: "var(--info)",
  neutral: "var(--muted)",
};

/** Categorical chart palette (--chart-1..6), cycled by index. */
export const CHART_COLORS = [1, 2, 3, 4, 5, 6].map((i) => `var(--chart-${i})`);

export const seriesColor = (i: number): string => CHART_COLORS[i % CHART_COLORS.length];

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Resolve an explicit colour, then a tone, then a fallback. */
export function resolveColor(color: string | undefined, tone: Tone | undefined, fallback: string): string {
  return color ?? (tone ? TONE_COLOR[tone] : fallback);
}

export function signTone(v: number): Tone {
  return v > 0 ? "good" : v < 0 ? "bad" : "neutral";
}

/** Default compact number formatter used when a chart is not given its own. */
export function fmtNum(v: number, digits = 2): string {
  if (!isNum(v)) return "n/a";
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(a >= 100 ? 0 : digits);
}

/** Inline empty state shared by all viz components. */
export function ChartEmpty({ children, height }: { children: ReactNode; height?: number }) {
  return (
    <p className="flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-sm text-muted" style={{ minHeight: height ?? 96 }}>
      {children}
    </p>
  );
}

/** Small colour swatch + label legend row. */
export function Legend({ items }: { items: { label: ReactNode; color: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((it, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: it.color }} aria-hidden />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
