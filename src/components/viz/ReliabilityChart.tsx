"use client";

import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { AXIS, GRID, TOOLTIP } from "./chart-kit";
import { ChartEmpty, isNum } from "./shared";

export type ReliabilityPoint = { predicted: number; realised: number; /** Sample size; drives the dot size. */ n: number };

export type ReliabilityChartProps = {
  points: ReliabilityPoint[];
  /** Axis range (default 0..1 for probabilities). */
  domain?: [number, number];
  format?: (v: number) => string;
  xLabel?: string;
  yLabel?: string;
  height?: number;
  ariaLabel?: string;
  emptyText?: string;
};

const pct0 = (v: number) => `${Math.round(v * 100)}%`;

export function ReliabilityChart({ points, domain = [0, 1], format = pct0, xLabel = "Predicted", yLabel = "Realised", height = 280, ariaLabel = "Calibration: predicted versus realised", emptyText = "Not enough resolved predictions to draw calibration yet." }: ReliabilityChartProps) {
  const data = points.filter((p) => isNum(p.predicted) && isNum(p.realised) && isNum(p.n) && p.n > 0);
  if (data.length === 0) return <ChartEmpty height={height}>{emptyText}</ChartEmpty>;
  const [d0, d1] = domain;
  return (
    <div style={{ height }} role="img" aria-label={`${ariaLabel}: ${data.length} buckets; points on the diagonal mean perfectly calibrated`}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis type="number" dataKey="predicted" name={xLabel} domain={domain} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={format} label={{ value: xLabel, position: "insideBottom", offset: -10, fontSize: 11, fill: "var(--muted)" }} />
          <YAxis type="number" dataKey="realised" name={yLabel} domain={domain} tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={format} />
          <ZAxis type="number" dataKey="n" name="Samples" range={[60, 420]} />
          <ReferenceLine segment={[{ x: d0, y: d0 }, { x: d1, y: d1 }]} stroke="var(--muted)" strokeDasharray="5 4" ifOverflow="visible" />
          <Tooltip
            {...TOOLTIP}
            cursor={{ strokeDasharray: "3 3", stroke: "var(--border)" }}
            formatter={(v, name) => [name === "Samples" ? String(v) : format(Number(v)), String(name)]}
          />
          <Scatter data={data} fill="var(--chart-1)" fillOpacity={0.8} stroke="var(--surface)" isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
