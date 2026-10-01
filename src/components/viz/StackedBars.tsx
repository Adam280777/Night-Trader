"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Tone } from "@/lib/format";
import { AXIS, GRID, TOOLTIP } from "./chart-kit";
import { ChartEmpty, fmtNum, Legend, resolveColor, seriesColor } from "./shared";

export type StackedBarsSeries = { key: string; name?: string; tone?: Tone; color?: string };

export type StackedBarsProps = {
  /** One object per x category, with a numeric field per series key. */
  data: Record<string, number | string | null | undefined>[];
  series: StackedBarsSeries[];
  xKey?: string;
  height?: number;
  formatValue?: (v: number) => string;
  formatX?: (x: string | number) => string;
  legend?: boolean;
  /** Draw bars side by side instead of stacked. */
  grouped?: boolean;
  ariaLabel?: string;
  emptyText?: string;
};

export function StackedBars({ data, series, xKey = "x", height = 220, formatValue = (v) => fmtNum(v, 0), formatX, legend = true, grouped = false, ariaLabel = "Stacked bar chart", emptyText = "Nothing to chart yet." }: StackedBarsProps) {
  if (data.length === 0 || series.length === 0) return <ChartEmpty height={height}>{emptyText}</ChartEmpty>;
  const colors = series.map((s, i) => resolveColor(s.color, s.tone, seriesColor(i)));
  return (
    <div>
      {legend && series.length > 1 && (
        <div className="mb-2">
          <Legend items={series.map((s, i) => ({ label: s.name ?? s.key, color: colors[i] }))} />
        </div>
      )}
      <div style={{ height }} role="img" aria-label={`${ariaLabel}: ${series.map((s) => s.name ?? s.key).join(", ")} across ${data.length} categories`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} minTickGap={12} interval="preserveStartEnd" tickFormatter={(v) => (formatX ? formatX(v) : String(v))} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} tickFormatter={(v) => formatValue(Number(v))} />
            <Tooltip {...TOOLTIP} labelFormatter={(l) => (formatX ? formatX(l as string | number) : String(l))} formatter={(v, name) => [formatValue(Number(v)), String(name)]} />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.name ?? s.key} stackId={grouped ? undefined : "a"} fill={colors[i]} isAnimationActive={false} radius={grouped ? [3, 3, 0, 0] : i === series.length - 1 ? [3, 3, 0, 0] : 0} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
