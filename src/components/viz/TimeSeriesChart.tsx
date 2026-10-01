"use client";

import { useId, useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Tone } from "@/lib/format";
import { AXIS, fmtDateTime, fmtTick, GRID, TOOLTIP } from "./chart-kit";
import { ChartEmpty, fmtNum, isNum, Legend, resolveColor, seriesColor, TONE_COLOR } from "./shared";

export type TimeSeriesDatum = Record<string, number | string | null | undefined>;

export type TimeSeriesSeries = {
  /** Key in each datum holding this series' value. */
  key: string;
  name?: string;
  kind?: "line" | "area";
  tone?: Tone;
  color?: string;
  dashed?: boolean;
};

export type TimeSeriesChartProps = {
  data: TimeSeriesDatum[];
  series: TimeSeriesSeries[];
  /** Key holding the x value: a ms timestamp when xType is "time", a label otherwise. */
  xKey?: string;
  xType?: "time" | "category";
  height?: number;
  formatValue?: (v: number) => string;
  /** Custom x tick / tooltip label formatter (defaults to dates for "time"). */
  formatX?: (x: number | string) => string;
  referenceLines?: { y: number; label?: string; tone?: Tone }[];
  /** Draw an emphasised zero line (default true). */
  zeroLine?: boolean;
  /** Colour the first series green above zero and red below it. */
  splitZero?: boolean;
  curve?: "monotone" | "linear" | "step";
  connectNulls?: boolean;
  /** Show a legend (default: when there is more than one series). */
  legend?: boolean;
  yWidth?: number;
  ariaLabel?: string;
  emptyText?: string;
};

export function TimeSeriesChart({
  data,
  series,
  xKey = "x",
  xType = "time",
  height = 240,
  formatValue = (v) => fmtNum(v),
  formatX,
  referenceLines,
  zeroLine = true,
  splitZero = false,
  curve = "monotone",
  connectNulls = false,
  legend,
  yWidth = 56,
  ariaLabel = "Time series chart",
  emptyText = "Not enough data to draw this chart yet.",
}: TimeSeriesChartProps) {
  const uid = useId().replace(/:/g, "");
  const rows = useMemo(() => data.filter((d) => (xType === "time" ? isNum(d[xKey]) : d[xKey] != null)), [data, xKey, xType]);
  const hasAnyValue = series.some((s) => rows.filter((d) => isNum(d[s.key])).length >= 2);
  if (rows.length < 2 || !hasAnyValue) return <ChartEmpty height={height}>{emptyText}</ChartEmpty>;

  const xs = xType === "time" ? rows.map((d) => Number(d[xKey])) : [];
  const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const tickX = (v: number | string) => (formatX ? formatX(v) : xType === "time" ? fmtTick(Number(v), span) : String(v));
  const labelX = (v: number | string) => (formatX ? formatX(v) : xType === "time" ? fmtDateTime(Number(v)) : String(v));

  let off = 1;
  if (splitZero) {
    const vals = rows.map((d) => d[series[0].key]).filter(isNum);
    const hi = Math.max(0, ...vals);
    const lo = Math.min(0, ...vals);
    off = hi === lo ? 1 : hi / (hi - lo);
  }
  const colors = series.map((s, i) => resolveColor(s.color, s.tone, seriesColor(i)));
  const showLegend = legend ?? series.length > 1;

  return (
    <div>
      {showLegend && (
        <div className="mb-2">
          <Legend items={series.map((s, i) => ({ label: s.name ?? s.key, color: colors[i] }))} />
        </div>
      )}
      <div style={{ height }} role="img" aria-label={`${ariaLabel}: ${series.map((s) => s.name ?? s.key).join(", ")}, ${rows.length} points`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`ts-${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors[i]} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={colors[i]} stopOpacity={0} />
                </linearGradient>
              ))}
              {splitZero && (
                <>
                  <linearGradient id={`ts-${uid}-sf`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset={0} stopColor={TONE_COLOR.good} stopOpacity={0.3} />
                    <stop offset={off} stopColor={TONE_COLOR.good} stopOpacity={0.05} />
                    <stop offset={off} stopColor={TONE_COLOR.bad} stopOpacity={0.05} />
                    <stop offset={1} stopColor={TONE_COLOR.bad} stopOpacity={0.3} />
                  </linearGradient>
                  <linearGradient id={`ts-${uid}-ss`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset={0} stopColor={TONE_COLOR.good} />
                    <stop offset={off} stopColor={TONE_COLOR.good} />
                    <stop offset={off} stopColor={TONE_COLOR.bad} />
                    <stop offset={1} stopColor={TONE_COLOR.bad} />
                  </linearGradient>
                </>
              )}
            </defs>
            <CartesianGrid stroke={GRID} vertical={false} />
            {xType === "time" ? (
              <XAxis dataKey={xKey} type="number" scale="time" domain={["dataMin", "dataMax"]} tick={AXIS} tickLine={false} axisLine={false} minTickGap={24} tickFormatter={tickX} />
            ) : (
              <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} tickFormatter={tickX} />
            )}
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={yWidth} tickFormatter={(v) => formatValue(Number(v))} domain={["auto", "auto"]} />
            <Tooltip {...TOOLTIP} labelFormatter={(l) => labelX(l as number | string)} formatter={(v, name) => [isNum(Number(v)) ? formatValue(Number(v)) : "n/a", String(name)]} />
            {zeroLine && <ReferenceLine y={0} stroke="var(--muted)" strokeOpacity={0.5} />}
            {referenceLines?.map((r, i) => (
              <ReferenceLine key={i} y={r.y} stroke={TONE_COLOR[r.tone ?? "neutral"]} strokeDasharray="4 3" label={r.label ? { value: r.label, position: "insideTopRight", fontSize: 11, fill: "var(--muted)" } : undefined} />
            ))}
            {series.map((s, i) => {
              const split = splitZero && i === 0;
              const common = { dataKey: s.key, name: s.name ?? s.key, type: curve, connectNulls, dot: false, isAnimationActive: false, strokeWidth: 2, strokeDasharray: s.dashed ? "5 4" : undefined } as const;
              const stroke = split ? `url(#ts-${uid}-ss)` : colors[i];
              return s.kind === "line" ? <Line key={s.key} {...common} stroke={stroke} /> : <Area key={s.key} {...common} stroke={stroke} fill={split ? `url(#ts-${uid}-sf)` : `url(#ts-${uid}-${i})`} />;
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
