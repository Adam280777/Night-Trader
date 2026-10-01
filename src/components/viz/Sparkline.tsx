import { useId } from "react";
import type { Tone } from "@/lib/format";
import { fmtNum, isNum, resolveColor, TONE_COLOR } from "./shared";

export type SparklineProps = {
  values: readonly (number | null | undefined)[];
  /** "auto" colours green/red by last vs first value. */
  tone?: Tone | "auto";
  color?: string;
  area?: boolean;
  width?: number;
  height?: number;
  strokeWidth?: number;
  /** Fill the container width (drops the end dot, which would distort). */
  stretch?: boolean;
  /** Accessible name; a summary of first/last values is appended. */
  label?: string;
  className?: string;
};

export function Sparkline({ values, tone = "auto", color, area = true, width = 96, height = 28, strokeWidth = 1.75, stretch = false, label = "Trend", className = "" }: SparklineProps) {
  const uid = useId().replace(/:/g, "");
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => isNum(p.v));
  const svgProps = {
    width: stretch ? "100%" : width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: stretch ? ("none" as const) : undefined,
    className: `overflow-visible ${className}`,
  };

  if (pts.length < 2) {
    return (
      <svg {...svgProps} role="img" aria-label={`${label}: not enough data`}>
        <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="var(--border)" strokeWidth={1.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }

  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const t: Tone = tone === "auto" ? (last > first ? "good" : last < first ? "bad" : "neutral") : tone;
  const stroke = resolveColor(color, t, TONE_COLOR.neutral);
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const pad = strokeWidth + 1;
  const span = max - min;
  const lastIndex = Math.max(1, values.length - 1);
  const x = (i: number) => pad + (i / lastIndex) * (width - pad * 2);
  const y = (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2));
  const line = pts.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(" ");
  const areaPath = `${line} L${x(pts[pts.length - 1].i).toFixed(2)},${height} L${x(pts[0].i).toFixed(2)},${height} Z`;

  return (
    <svg {...svgProps} role="img" aria-label={`${label}: ${pts.length} points, from ${fmtNum(first)} to ${fmtNum(last)}`}>
      {area && (
        <>
          <defs>
            <linearGradient id={`sp-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#sp-${uid})`} stroke="none" />
        </>
      )}
      <path d={line} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {!stretch && <circle cx={x(pts[pts.length - 1].i)} cy={y(last)} r={2.25} fill={stroke} />}
    </svg>
  );
}
