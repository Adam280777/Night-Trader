import type { ReactNode } from "react";
import type { Tone } from "@/lib/format";
import { ChartEmpty, fmtNum, isNum, resolveColor, seriesColor } from "./shared";

export type DonutSegment = { label: string; value: number; tone?: Tone; color?: string };

export type DonutProps = {
  segments: DonutSegment[];
  /** Big text in the hole, e.g. a total. */
  centre?: ReactNode;
  centreLabel?: ReactNode;
  size?: number;
  /** Ring thickness in viewBox units (of 100). */
  thickness?: number;
  /** Formats the value shown in the legend. */
  format?: (v: number) => string;
  legend?: boolean;
  ariaLabel?: string;
  emptyText?: ReactNode;
  className?: string;
};

const R = 40;
const C = 2 * Math.PI * R;

export function Donut({ segments, centre, centreLabel, size = 140, thickness = 16, format = (v) => fmtNum(v, 0), legend = true, ariaLabel = "Breakdown", emptyText = "No data yet.", className = "" }: DonutProps) {
  const segs = segments.filter((s) => isNum(s.value) && s.value > 0);
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <ChartEmpty>{emptyText}</ChartEmpty>;

  const gap = segs.length > 1 ? Math.min(1.2, C / segs.length / 4) : 0;
  const arcs = segs.reduce<{ s: DonutSegment; i: number; len: number; offset: number; color: string }[]>((out, s, i) => {
    const len = (s.value / total) * C;
    const offset = out.reduce((sum, arc) => sum + arc.len + gap, 0);
    out.push({ s, i, len: Math.max(0, len - gap), offset, color: resolveColor(s.color, s.tone, seriesColor(i)) });
    return out;
  }, []);
  const summary = segs.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(0)}%`).join(", ");

  return (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${className}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={`${ariaLabel}: ${summary}`}>
          <circle cx={50} cy={50} r={R} fill="none" stroke="var(--surface-2)" strokeWidth={thickness} />
          <g transform="rotate(-90 50 50)">
            {arcs.map((a) => (
              <circle key={a.i} cx={50} cy={50} r={R} fill="none" stroke={a.color} strokeWidth={thickness} strokeDasharray={`${a.len} ${C - a.len}`} strokeDashoffset={-a.offset}>
                <title>{`${a.s.label}: ${format(a.s.value)} (${((a.s.value / total) * 100).toFixed(1)}%)`}</title>
              </circle>
            ))}
          </g>
        </svg>
        {(centre != null || centreLabel != null) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            {centre != null && <div className="tabular text-xl leading-tight font-semibold">{centre}</div>}
            {centreLabel != null && <div className="text-[11px] text-muted">{centreLabel}</div>}
          </div>
        )}
      </div>
      {legend && (
        <ul className="min-w-0 flex-1 space-y-1.5 text-sm" style={{ minWidth: 140 }}>
          {arcs.map((a) => (
            <li key={a.i} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: a.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{a.s.label}</span>
              <span className="tabular text-muted">{format(a.s.value)}</span>
              <span className="tabular w-10 text-right text-xs text-muted">{((a.s.value / total) * 100).toFixed(0)}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
