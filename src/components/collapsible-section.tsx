"use client";

import { useState, type ReactNode } from "react";

export function CollapsibleSection({
  title,
  description,
  defaultOpen = false,
  danger = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`rounded-xl border bg-surface ${danger ? "border-danger/40" : "border-border"}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span>
          <span className={`text-sm font-semibold ${danger ? "text-danger" : ""}`}>{title}</span>
          {description && <span className="mt-1 block max-w-2xl text-xs text-muted">{description}</span>}
        </span>
        <span className="shrink-0 text-lg text-muted" aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open && <div className="border-t border-border px-5 pb-4">{children}</div>}
    </section>
  );
}
