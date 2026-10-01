import type { Tone } from "@/lib/format";
import { clamp, fmtNum, isNum, TONE_COLOR } from "./shared";

export type GaugeBand = { /** Upper bound of the band (bands run from the previous bound, starting at min). */ to: number; tone: Tone; label?: string };

export type GaugeProps = {
  value: number | null | undefined;
  min?: number;
  max?: number;
  bands?: GaugeBand[];
  /** Formats the big centre number and the min/max end labels. */
  format?: (v: number) => string;
  /** Small caption under the number. */
  label?: string;
  /** Accessible name, e.g. "Win probability". */
  ariaLabel?: string;
  /** Rendered width in px. */
  size?: number;
  className?: string;
};

const CX = 100;
const CY = 100;
const R = 80;

// Fraction 0..1 along the semicircle, left to right over the top.
function pt(f: number, r = R) {
  const a = Math.PI * (1 - f);
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
}

function arc(f0: number, f1: number) {
  const a = pt(f0);
  const b = pt(f1);
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)} A${R},${R} 0 0 1 ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
}

export function Gauge({ value, min = 0, max = 1, bands, format = (v) => fmtNum(v), label, ariaLabel = "Gauge", size = 180, className = "" }: GaugeProps) {
  const range = max - min > 0 ? max - min : 1;
  const frac = (v: number) => clamp((v - min) / range, 0, 1);
  const has = isNum(value);
  const f = has ? frac(value) : 0;

  const segs: { f0: number; f1: number; tone: Tone }[] = [];
  let prev = 0;
  for (const b of [...(bands ?? [])].sort((p, q) => p.to - q.to)) {
    const f1 = frac(b.to);
    if (f1 > prev) segs.push({ f0: prev, f1, tone: b.tone });
    prev = Math.max(prev, f1);
  }
  const activeBand = has ? (bands ?? []).slice().sort((p, q) => p.to - q.to).find((b) => value <= b.to) : undefined;
  const valueColor = has ? (activeBand ? TONE_COLOR[activeBand.tone] : "var(--accent)") : "var(--muted)";
  const needle = pt(f, R);
  const text = has ? format(value) : "n/a";

  return (
    <svg
      viewBox="0 0 200 124"
      width={size}
      height={(size * 124) / 200}
      className={`max-w-full ${className}`}
      role="img"
      aria-label={`${ariaLabel}: ${text}${activeBand?.label ? `, ${activeBand.label}` : ""}`}
    >
      <path d={arc(0, 1)} fill="none" stroke="var(--border)" strokeWidth={14} strokeLinecap="butt" />
      {segs.map((s, i) => (
        <path key={i} d={arc(s.f0, s.f1)} fill="none" stroke={TONE_COLOR[s.tone]} strokeOpacity={0.3} strokeWidth={14} />
      ))}
      {has && f > 0 && <path d={arc(0, f)} fill="none" stroke={valueColor} strokeWidth={14} strokeLinecap="butt" />}
      {has && <circle cx={needle.x} cy={needle.y} r={9} fill="var(--surface)" stroke={valueColor} strokeWidth={3} />}
      <text x={CX} y={92} textAnchor="middle" fontSize={26} fontWeight={600} fill="var(--fg)" style={{ fontVariantNumeric: "tabular-nums" }}>
        {text}
      </text>
      {label && (
        <text x={CX} y={112} textAnchor="middle" fontSize={11} fill="var(--muted)">
          {label}
        </text>
      )}
      <text x={CX - R} y={118} textAnchor="middle" fontSize={10} fill="var(--muted)" style={{ fontVariantNumeric: "tabular-nums" }}>
        {format(min)}
      </text>
      <text x={CX + R} y={118} textAnchor="middle" fontSize={10} fill="var(--muted)" style={{ fontVariantNumeric: "tabular-nums" }}>
        {format(max)}
      </text>
    </svg>
  );
}
