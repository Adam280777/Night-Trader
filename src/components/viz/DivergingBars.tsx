import type { ReactNode } from "react";
import { ChartEmpty, fmtNum, isNum, TONE_COLOR } from "./shared";

export type DivergingRow = {
  label: ReactNode;
  value: number;
  /** Optional marker (e.g. the prior / starting weight) drawn as a tick on the same axis. */
  reference?: number;
  /** Tooltip text for the row. */
  hint?: string;
};

export type DivergingBarsProps = {
  rows: DivergingRow[];
  /** Symmetric half-range of the axis; defaults to the largest absolute value or reference. */
  max?: number;
  format?: (v: number) => string;
  /** Legend text for the tick marker. */
  referenceLabel?: string;
  /** Width of the label column in px. */
  labelWidth?: number;
  ariaLabel?: string;
  emptyText?: ReactNode;
  className?: string;
};

export function DivergingBars({ rows, max, format = (v) => fmtNum(v), referenceLabel = "prior", labelWidth = 150, ariaLabel = "Signed values", emptyText = "Nothing to show yet.", className = "" }: DivergingBarsProps) {
  if (rows.length === 0) return <ChartEmpty>{emptyText}</ChartEmpty>;
  const abs = rows.flatMap((r) => [isNum(r.value) ? Math.abs(r.value) : 0, isNum(r.reference) ? Math.abs(r.reference) : 0]);
  const half = max && max > 0 ? max : Math.max(...abs, 1e-9);
  const hasRef = rows.some((r) => isNum(r.reference));
  const pctOf = (v: number) => Math.min(50, (Math.abs(v) / half) * 50);

  return (
    <div className={className}>
      <ul className="space-y-1.5" role="list" aria-label={ariaLabel}>
        {rows.map((r, i) => {
          const v = isNum(r.value) ? r.value : 0;
          const sign = v >= 0;
          return (
            <li key={i} className="flex items-center gap-3 text-sm" title={r.hint}>
              <span className="shrink-0 truncate text-muted" style={{ width: labelWidth }}>
                {r.label}
              </span>
              <span className="relative h-5 min-w-0 flex-1 rounded bg-surface-2" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <span className="absolute inset-y-1 rounded-sm" style={{ background: sign ? TONE_COLOR.good : TONE_COLOR.bad, [sign ? "left" : "right"]: "50%", width: `${pctOf(v)}%` }} />
                {isNum(r.reference) && (
                  <span className="absolute inset-y-0 w-0.5 rounded bg-fg opacity-70" style={{ left: `${50 + (r.reference >= 0 ? 1 : -1) * pctOf(r.reference)}%`, transform: "translateX(-1px)" }} />
                )}
              </span>
              <span className="tabular w-16 shrink-0 text-right font-medium">{format(v)}</span>
              {isNum(r.reference) && (
                <span className="sr-only">
                  {referenceLabel} {format(r.reference)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {hasRef && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <span className="inline-block h-3 w-0.5 rounded bg-fg opacity-70" aria-hidden />
          {referenceLabel}
        </p>
      )}
    </div>
  );
}
