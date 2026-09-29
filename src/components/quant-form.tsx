"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Search } from "lucide-react";
import type { Settings } from "@/lib/config";
import {
  DEFAULT_TUNING,
  GROUP_META,
  PARAMS_BY_GROUP,
  TUNING_GROUPS,
  TUNING_PARAMS,
  TUNING_PRESETS,
  type QuantTuning,
  type TuningGroup,
  type TuningParam,
} from "@/lib/quant/tuning";
import { Num, Row, Toggle } from "./settings-form";

/** One tunable engine parameter, rendered from its registry entry. */
function TuningRow({ param, tuning, onChange }: { param: TuningParam; tuning: QuantTuning; onChange: (patch: Partial<QuantTuning>) => void }) {
  const raw = tuning[param.key];
  const changed = raw !== DEFAULT_TUNING[param.key];

  const label = (
    <span className="inline-flex items-center gap-2">
      {param.label}
      {changed && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-accent uppercase">changed</span>}
    </span>
  );

  if (param.kind === "boolean") {
    return (
      <Row label={label} hint={param.hint}>
        <Toggle on={raw as boolean} onChange={(v) => onChange({ [param.key]: v } as Partial<QuantTuning>)} label={param.label} />
      </Row>
    );
  }

  // Metadata min/max/step are already expressed in display units, so only the value is scaled.
  const scale = param.scale ?? 1;
  const shown = Math.round((raw as number) * scale * 1000) / 1000;

  return (
    <Row label={label} hint={param.hint}>
      <span className="flex items-center gap-2">
        <Num
          value={shown}
          step={param.step}
          min={param.min}
          max={param.max}
          suffix={param.unit}
          onCommit={(v) => onChange({ [param.key]: v / scale } as Partial<QuantTuning>)}
        />
        {changed && (
          <button
            onClick={() => onChange({ [param.key]: DEFAULT_TUNING[param.key] } as Partial<QuantTuning>)}
            title={`Reset to the shipped value (${Math.round((DEFAULT_TUNING[param.key] as number) * scale * 1000) / 1000}${param.unit ? ` ${param.unit}` : ""})`}
            aria-label={`Reset ${param.label}`}
            className="text-muted hover:text-fg"
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </button>
        )}
      </span>
    </Row>
  );
}

export function QuantForm({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ engine: true });
  const [query, setQuery] = useState("");

  async function save(patch: Partial<QuantTuning>) {
    setMsg(null);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quant: patch }) });
    const j = await r.json();
    if (!r.ok) return setMsg({ ok: false, text: j.error ?? "Could not save" });
    setS(j);
    setMsg({ ok: true, text: "Saved" });
    router.refresh();
  }

  const tuning = s.quant;
  const q = query.trim().toLowerCase();
  const matches = (p: TuningParam) => !q || p.label.toLowerCase().includes(q) || p.hint.toLowerCase().includes(q) || p.key.toLowerCase().includes(q);

  const changedKeys = TUNING_PARAMS.filter((p) => tuning[p.key] !== DEFAULT_TUNING[p.key]);
  const changedIn = (group: TuningGroup) => PARAMS_BY_GROUP(group).filter((p) => tuning[p.key] !== DEFAULT_TUNING[p.key]).length;
  const resetGroup = (group: TuningGroup) => save(Object.fromEntries(PARAMS_BY_GROUP(group).map((p) => [p.key, DEFAULT_TUNING[p.key]])) as Partial<QuantTuning>);
  const resetAll = () => save(Object.fromEntries(TUNING_PARAMS.map((p) => [p.key, DEFAULT_TUNING[p.key]])) as Partial<QuantTuning>);

  return (
    <div className="space-y-6">
      {msg && (
        <p role="status" className={`text-sm ${msg.ok ? "text-accent" : "text-danger"}`}>
          {msg.text}
        </p>
      )}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Starting points</h2>
        <p className="mt-1 text-xs text-muted">
          A preset overwrites only the values it covers. Everything else keeps whatever you have set.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(TUNING_PRESETS).map(([id, preset]) => (
            <button
              key={id}
              onClick={() => save(preset.values)}
              className="flex-1 basis-56 rounded-lg border border-border p-3 text-left transition-colors hover:border-accent"
            >
              <span className="text-sm font-medium">{preset.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{preset.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative flex-1 basis-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every parameter…"
            aria-label="Search parameters"
            className="w-full rounded-lg border border-border bg-surface py-2 pr-3 pl-9 text-sm outline-none focus:border-accent"
          />
        </label>
        <span className="text-xs text-muted">
          {changedKeys.length === 0 ? (
            "Everything is at its shipped value"
          ) : (
            <>
              {changedKeys.length} of {TUNING_PARAMS.length} changed ·{" "}
              <button onClick={resetAll} className="underline underline-offset-2 hover:text-fg">
                reset all
              </button>
            </>
          )}
        </span>
      </div>

      <div className="space-y-3">
        {TUNING_GROUPS.map((group) => {
          const meta = GROUP_META[group];
          const params = PARAMS_BY_GROUP(group).filter(matches);
          if (params.length === 0) return null;
          const n = changedIn(group);
          // A search should show what it found rather than make you open every section.
          const isOpen = q ? true : (open[group] ?? false);
          return (
            <section key={group} className="rounded-xl border border-border bg-surface">
              <button
                onClick={() => setOpen((o) => ({ ...o, [group]: !isOpen }))}
                aria-expanded={isOpen}
                disabled={!!q}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
              >
                <span>
                  <span className="text-sm font-semibold">{meta.title}</span>
                  {n > 0 && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{n} changed</span>}
                  <span className="mt-1 block max-w-2xl text-xs text-muted">{meta.blurb}</span>
                </span>
                {!q && <span className="shrink-0 text-lg text-muted">{isOpen ? "−" : "+"}</span>}
              </button>
              {isOpen && (
                <div className="border-t border-border px-5 pb-4">
                  {params.map((p) => (
                    <TuningRow key={p.key} param={p} tuning={tuning} onChange={save} />
                  ))}
                  {!q && (
                    <div className="pt-3">
                      <button onClick={() => resetGroup(group)} disabled={n === 0} className="text-xs text-muted underline underline-offset-2 hover:text-fg disabled:no-underline disabled:opacity-50">
                        Reset this section to defaults
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {q && TUNING_PARAMS.filter(matches).length === 0 && <p className="text-sm text-muted">Nothing matches “{query}”.</p>}
      </div>
    </div>
  );
}
