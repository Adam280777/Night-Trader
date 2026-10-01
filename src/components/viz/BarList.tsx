import type { ReactNode } from "react";
import type { Tone } from "@/lib/format";
import { ChartEmpty, fmtNum, isNum, resolveColor, seriesColor } from "./shared";

export type BarListItem = {
  label: ReactNode;
  value: number;
  /** Replaces the formatted value on the right. */
  display?: ReactNode;
  /** Muted secondary text under the label. */
  sub?: ReactNode;
  tone?: Tone;
  color?: string;
};

export type BarListProps = {
  items: BarListItem[];
  /** Value that represents a full bar; defaults to the largest item. */
  max?: number;
  format?: (v: number) => string;
  /** Show only the first N items (items are shown in the order given). */
  limit?: number;
  /** Default bar colour when an item has none: a tone, or the categorical palette by index. */
  tone?: Tone | "palette";
  ariaLabel?: string;
  emptyText?: ReactNode;
  className?: string;
};

export function BarList({ items, max, format = (v) => fmtNum(v), limit, tone = "info", ariaLabel = "Ranking", emptyText = "Nothing to show yet.", className = "" }: BarListProps) {
  const shown = (limit ? items.slice(0, limit) : items).filter((it) => isNum(it.value));
  if (shown.length === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const top = max && max > 0 ? max : Math.max(...shown.map((s) => Math.abs(s.value)), 1e-9);
  return (
    <ul className={`space-y-3 ${className}`} role="list" aria-label={ariaLabel}>
      {shown.map((it, i) => {
        const color = resolveColor(it.color, it.tone ?? (tone === "palette" ? undefined : tone), seriesColor(i));
        const w = Math.min(100, (Math.abs(it.value) / top) * 100);
        return (
          <li key={i}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{it.label}</span>
              <span className="tabular shrink-0 font-medium">{it.display ?? format(it.value)}</span>
            </div>
            {it.sub != null && <div className="text-xs text-muted">{it.sub}</div>}
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
