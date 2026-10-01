import type { ReactNode } from "react";
import { ChartEmpty, fmtNum, isNum } from "./shared";

export type HeatmapDay = {
  /** "YYYY-MM-DD" (preferred, timezone-free) or a ms timestamp (read as UTC). */
  date: string | number;
  value: number | null | undefined;
  /** Extra tooltip text. */
  label?: string;
};

export type CalendarHeatmapProps = {
  days: HeatmapDay[];
  /** Number of week columns shown, ending with the week of the last day. */
  weeks?: number;
  format?: (v: number) => string;
  /** Value at which colour saturates; defaults to the largest absolute value. */
  scaleMax?: number;
  /** Last day shown ("YYYY-MM-DD"); defaults to the latest date in `days`. */
  endDate?: string;
  cell?: number;
  gap?: number;
  ariaLabel?: string;
  emptyText?: ReactNode;
  className?: string;
};

const DAY = 86400_000;
const WD = ["Mon", "", "Wed", "", "Fri", "", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDayKey(d: string | number): number | null {
  if (typeof d === "number") return Number.isFinite(d) ? Math.floor(d / DAY) : null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY);
}

const keyToIso = (k: number) => new Date(k * DAY).toISOString().slice(0, 10);
// 1970-01-01 was a Thursday; row 0 = Monday.
const weekday = (k: number) => (((k + 3) % 7) + 7) % 7;

export function CalendarHeatmap({ days, weeks = 26, format = (v) => fmtNum(v), scaleMax, endDate, cell = 14, gap = 3, ariaLabel = "Daily results calendar", emptyText = "No daily results yet.", className = "" }: CalendarHeatmapProps) {
  const byDay = new Map<number, { sum: number; label?: string }>();
  for (const d of days) {
    const k = toDayKey(d.date);
    if (k == null || !isNum(d.value)) continue;
    const e = byDay.get(k);
    byDay.set(k, { sum: (e?.sum ?? 0) + d.value, label: d.label ?? e?.label });
  }
  if (byDay.size === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;

  const n = Math.max(1, Math.min(60, Math.floor(weeks)));
  const lastKey = (endDate ? toDayKey(endDate) : null) ?? Math.max(...byDay.keys());
  const lastWeekStart = lastKey - weekday(lastKey);
  const firstWeekStart = lastWeekStart - (n - 1) * 7;
  const peak = scaleMax && scaleMax > 0 ? scaleMax : Math.max(...[...byDay.values()].map((e) => Math.abs(e.sum)), 1e-9);

  const left = 28;
  const top = 16;
  const step = cell + gap;
  const width = left + n * step;
  const height = top + 7 * step;

  const cells: ReactNode[] = [];
  const monthLabels: ReactNode[] = [];
  let wins = 0;
  let losses = 0;
  let lastMonth = -1;
  for (let w = 0; w < n; w++) {
    const wkStart = firstWeekStart + w * 7;
    const m = new Date(wkStart * DAY).getUTCMonth();
    if (m !== lastMonth) {
      monthLabels.push(
        <text key={`m${w}`} x={left + w * step} y={10} fontSize={10} fill="var(--muted)">
          {MONTHS[m]}
        </text>,
      );
      lastMonth = m;
    }
    for (let r = 0; r < 7; r++) {
      const k = wkStart + r;
      if (k > lastKey) continue;
      const e = byDay.get(k);
      const x = left + w * step;
      const y = top + r * step;
      const iso = keyToIso(k);
      if (!e) {
        cells.push(
          <rect key={k} x={x} y={y} width={cell} height={cell} rx={3} fill="var(--surface-2)" opacity={0.6}>
            <title>{`${iso}: no data`}</title>
          </rect>,
        );
        continue;
      }
      if (e.sum > 0) wins++;
      else if (e.sum < 0) losses++;
      const strength = Math.min(1, Math.abs(e.sum) / peak);
      cells.push(
        <rect key={k} x={x} y={y} width={cell} height={cell} rx={3} fill={e.sum === 0 ? "var(--muted)" : e.sum > 0 ? "var(--accent)" : "var(--danger)"} fillOpacity={e.sum === 0 ? 0.3 : 0.25 + 0.75 * strength}>
          <title>{`${iso}: ${format(e.sum)}${e.label ? ` (${e.label})` : ""}`}</title>
        </rect>,
      );
    }
  }

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxWidth: width * 1.5, height: "auto" }} role="img" aria-label={`${ariaLabel}: ${wins} positive and ${losses} negative days in the last ${n} weeks`}>
        {monthLabels}
        {WD.map((t, r) =>
          t ? (
            <text key={r} x={0} y={top + r * step + cell - 3} fontSize={9} fill="var(--muted)">
              {t}
            </text>
          ) : null,
        )}
        {cells}
      </svg>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted" aria-hidden>
        <span>Loss</span>
        {[-1, -0.5, 0, 0.5, 1].map((s) => (
          <span key={s} className="size-2.5 rounded-sm" style={{ background: s === 0 ? "var(--surface-2)" : s > 0 ? "var(--accent)" : "var(--danger)", opacity: s === 0 ? 1 : 0.25 + 0.75 * Math.abs(s) }} />
        ))}
        <span>Gain</span>
      </div>
    </div>
  );
}
