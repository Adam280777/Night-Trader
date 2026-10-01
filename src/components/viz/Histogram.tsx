"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS, GRID, TOOLTIP } from "./chart-kit";
import { ChartEmpty, fmtNum, isNum, TONE_COLOR } from "./shared";

export type HistogramProps = {
  values: readonly (number | null | undefined)[];
  /** Target number of bins (2..40). Bin edges are aligned so that 0 is always an edge. */
  bins?: number;
  /** Formats x-axis labels, tooltip bounds and the mean. */
  format?: (v: number) => string;
  /** Label for what is being counted in the tooltip. */
  countLabel?: string;
  showMean?: boolean;
  height?: number;
  ariaLabel?: string;
  emptyText?: string;
};

type Bin = { lo: number; hi: number; mid: number; count: number; label: string };

export function computeBins(values: number[], target: number): Bin[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const n = Math.max(2, Math.min(40, Math.round(target)));
  let width = (hi - lo) / n;
  if (!(width > 0)) width = Math.abs(hi) > 0 ? Math.abs(hi) / n : 1; // all values identical
  const start = Math.floor(lo / width) * width;
  const count = Math.max(1, Math.floor((hi - start) / width) + 1);
  const out: Bin[] = Array.from({ length: count }, (_, i) => {
    const a = start + i * width;
    return { lo: a, hi: a + width, mid: a + width / 2, count: 0, label: "" };
  });
  for (const v of values) out[Math.min(count - 1, Math.max(0, Math.floor((v - start) / width)))].count++;
  return out;
}

export function Histogram({ values, bins = 12, format = (v) => fmtNum(v, 1), countLabel = "Count", showMean = true, height = 220, ariaLabel = "Distribution of values", emptyText = "Not enough data for a distribution yet." }: HistogramProps) {
  const clean = useMemo(() => values.filter(isNum), [values]);
  const data = useMemo(() => (clean.length ? computeBins(clean, bins).map((b) => ({ ...b, label: format(b.mid) })) : []), [clean, bins, format]);
  if (clean.length === 0) return <ChartEmpty height={height}>{emptyText}</ChartEmpty>;

  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const meanBin = data.find((b) => mean >= b.lo && mean < b.hi) ?? data[data.length - 1];
  return (
    <div style={{ height }} role="img" aria-label={`${ariaLabel}: ${clean.length} values, mean ${format(mean)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <Tooltip
            {...TOOLTIP}
            labelFormatter={(_, p) => {
              const b = p?.[0]?.payload as Bin | undefined;
              return b ? `${format(b.lo)} to ${format(b.hi)}` : "";
            }}
            formatter={(v) => [String(v), countLabel]}
          />
          {showMean && meanBin && <ReferenceLine x={meanBin.label} stroke="var(--fg)" strokeDasharray="4 3" label={{ value: `mean ${format(mean)}`, position: "top", fontSize: 11, fill: "var(--muted)" }} />}
          <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((b, i) => (
              <Cell key={i} fill={b.mid >= 0 ? TONE_COLOR.good : TONE_COLOR.bad} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
