"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type SegmentOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

export type SegmentedControlProps<T extends string> = {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group, e.g. "Time range". */
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
};

// Arrow-key navigation across enabled items, shared by SegmentedControl and Tabs.
function moveFocus(e: KeyboardEvent<HTMLElement>, enabled: boolean[], current: number, go: (i: number) => void) {
  const n = enabled.length;
  let dir = 0;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = 1;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = -1;
  else if (e.key === "Home") dir = 2;
  else if (e.key === "End") dir = -2;
  if (!dir) return;
  e.preventDefault();
  let i = dir === 2 ? -1 : dir === -2 ? n : current;
  const step = dir === 2 ? 1 : dir === -2 ? -1 : dir;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (enabled[i]) return go(i);
  }
}

export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, size = "md", className = "" }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex rounded-lg border border-border bg-surface-2 p-0.5 ${className}`}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            tabIndex={active || (idx < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) =>
              moveFocus(e, options.map((x) => !x.disabled), i, (j) => {
                onChange(options[j].value);
                refs.current[j]?.focus();
              })
            }
            className={`rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} ${
              active ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export type TabItem = { id: string; label: ReactNode; content: ReactNode; /** Small badge after the label, e.g. a count. */ badge?: ReactNode; disabled?: boolean };

export type TabsProps = {
  tabs: TabItem[];
  /** Uncontrolled initial tab (defaults to the first). */
  defaultId?: string;
  /** Controlled mode. */
  value?: string;
  onChange?: (id: string) => void;
  ariaLabel?: string;
  className?: string;
};

export function Tabs({ tabs, defaultId, value, onChange, ariaLabel = "Sections", className = "" }: TabsProps) {
  const uid = useId();
  const [inner, setInner] = useState(defaultId ?? tabs[0]?.id);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (tabs.length === 0) return null;
  const current = value ?? inner;
  const activeIdx = Math.max(0, tabs.findIndex((t) => t.id === current));
  const select = (id: string) => {
    setInner(id);
    onChange?.(id);
  };
  const active = tabs[activeIdx];
  return (
    <div className={className}>
      <div role="tablist" aria-label={ariaLabel} className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t, i) => {
          const on = i === activeIdx;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${uid}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              onKeyDown={(e) =>
                moveFocus(e, tabs.map((x) => !x.disabled), i, (j) => {
                  select(tabs[j].id);
                  refs.current[j]?.focus();
                })
              }
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
                on ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t.label}
              {t.badge != null && <span className="tabular rounded-full bg-surface-2 px-1.5 text-xs text-muted">{t.badge}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${uid}-panel-${active.id}`} aria-labelledby={`${uid}-tab-${active.id}`} tabIndex={0} className="pt-4">
        {active.content}
      </div>
    </div>
  );
}
