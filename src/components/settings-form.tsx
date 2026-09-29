"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Settings } from "@/lib/config";
import {
  DEFAULT_TUNING,
  GROUP_META,
  PARAMS_BY_GROUP,
  TUNING_GROUPS,
  TUNING_PRESETS,
  type QuantTuning,
  type TuningGroup,
  type TuningParam,
} from "@/lib/quant/tuning";

interface Props {
  settings: Settings;
  t212Env: "demo" | "live";
  hasT212Keys: boolean;
}

function Row({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div className="max-w-md">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-border"}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function Num({
  value,
  onCommit,
  step = 1,
  suffix,
  min,
  max,
}: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  const [v, setV] = useState(String(value));
  // Presets and section resets change the value from outside, so the text state has to follow it.
  // Adjusting during render is React's recommended alternative to a syncing effect.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setV(String(value));
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n !== value) onCommit(n);
          else setV(String(value));
        }}
        className="tabular w-24 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-right text-sm outline-none focus:border-accent"
      />
      {suffix && <span className="w-24 text-xs text-muted">{suffix}</span>}
    </span>
  );
}

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
      <Num
        value={shown}
        step={param.step}
        min={param.min}
        max={param.max}
        suffix={param.unit}
        onCommit={(v) => onChange({ [param.key]: v / scale } as Partial<QuantTuning>)}
      />
    </Row>
  );
}

export function SettingsForm({ settings, t212Env, hasT212Keys }: Props) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ engine: true });

  async function save(patch: Record<string, unknown>) {
    setMsg(null);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (!r.ok) return setMsg({ ok: false, text: j.error ?? "Could not save" });
    setS(j);
    setMsg({ ok: true, text: "Saved" });
    router.refresh();
  }

  const saveQuant = (patch: Partial<QuantTuning>) => save({ quant: patch });
  const asPct = (v: number) => Math.round(v * 1000) / 10;

  const tuning = s.quant;
  const changedCount = (group: TuningGroup) => PARAMS_BY_GROUP(group).filter((p) => tuning[p.key] !== DEFAULT_TUNING[p.key]).length;
  const resetGroup = (group: TuningGroup) =>
    saveQuant(Object.fromEntries(PARAMS_BY_GROUP(group).map((p) => [p.key, DEFAULT_TUNING[p.key]])) as Partial<QuantTuning>);

  return (
    <div className="space-y-6">
      {msg && <p role="status" className={`text-sm ${msg.ok ? "text-accent" : "text-danger"}`}>{msg.text}</p>}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Trading mode</h2>
        <Row label="Connection" hint="Change these in API connections above.">
          <span className="text-sm">
            Trading 212 <b>{t212Env}</b> · keys {hasT212Keys ? "found" : <b className="text-danger">missing</b>} · every decision is computed locally
          </span>
        </Row>
        <Row label="Place orders" hint="Off = dry run: the engine screens, researches and decides exactly as normal, and the result is simulated from real prices. No orders are sent.">
          <Toggle on={s.tradingEnabled} onChange={(v) => save({ tradingEnabled: v })} label="Place orders" />
        </Row>
        {t212Env === "live" && s.tradingEnabled && !s.liveConfirmed && (
          <Row label="Confirm LIVE trading" hint="Real money. Type TRADE LIVE to allow real orders. Until then the app stays in dry run.">
            <span className="flex gap-2">
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="TRADE LIVE" className="w-32 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm" />
              <button onClick={() => save({ liveConfirmed: true, confirmText: confirm })} className="rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-white">
                Confirm
              </button>
            </span>
          </Row>
        )}
        <Row label="Ask me before every trade" hint="You approve or reject each proposal. No approval by the deadline means no trade.">
          <Toggle on={s.approvalMode} onChange={(v) => save({ approvalMode: v })} label="Approval mode" />
        </Row>
        <Row label="US market">
          <Toggle on={s.markets.US} onChange={(v) => save({ markets: { US: v } })} label="US market" />
        </Row>
        <Row label="UK market" hint="UK buys pay stamp duty, so a UK candidate has to clear a higher bar before it is worth taking.">
          <Toggle on={s.markets.UK} onChange={(v) => save({ markets: { UK: v } })} label="UK market" />
        </Row>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Safety limits</h2>
        <p className="mb-1 text-xs text-muted">
          Enforced after the engine decides, as a separate check. Nothing in the model below can raise or bypass them.
        </p>
        <Row label="Max position size" hint="Largest share of total account value in one stock.">
          <Num value={asPct(s.maxPositionPct)} step={1} suffix="%" onCommit={(v) => save({ maxPositionPct: v / 100 })} />
        </Row>
        <Row label="Max share of available cash" hint="Never invest more than this fraction of free cash.">
          <Num value={asPct(s.maxInvestPctOfCash)} step={1} suffix="%" onCommit={(v) => save({ maxInvestPctOfCash: v / 100 })} />
        </Row>
        <Row label="Cash always kept back">
          <Num value={s.minCashReserve} step={1} suffix="account currency" onCommit={(v) => save({ minCashReserve: v })} />
        </Row>
        <Row label="Daily loss circuit breaker" hint="No new trades after losing this much in 24 hours.">
          <Num value={asPct(s.dailyLossLimitPct)} step={0.5} suffix="%" onCommit={(v) => save({ dailyLossLimitPct: v / 100 })} />
        </Row>
        <Row label="Weekly loss circuit breaker">
          <Num value={asPct(s.weeklyLossLimitPct)} step={0.5} suffix="%" onCommit={(v) => save({ weeklyLossLimitPct: v / 100 })} />
        </Row>
        <Row label="Minimum confidence (US)" hint="The model's calibrated probability of clearing costs must be at least this before a buy is considered.">
          <Num value={asPct(s.minConfidence)} step={5} suffix="%" onCommit={(v) => save({ minConfidence: v / 100 })} />
        </Row>
        <Row label="Minimum confidence (UK)" hint="Normally set higher than the US floor to pay for stamp duty.">
          <Num value={asPct(s.ukMinConfidence)} step={5} suffix="%" onCommit={(v) => save({ ukMinConfidence: v / 100 })} />
        </Row>
        <Row label="Minimum expected edge" hint="Expected overnight move must beat estimated round-trip costs by this many percentage points.">
          <Num value={s.minExpectedEdgePct} step={0.1} suffix="%" onCommit={(v) => save({ minExpectedEdgePct: v })} />
        </Row>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Quant model</h2>
        <p className="mt-1 text-xs text-muted">
          Every number the decision engine uses. Changes apply to the next run, so nothing already in flight is affected. Each
          section can be reset on its own, and anything you have moved away from its shipped value is marked.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(TUNING_PRESETS).map(([id, preset]) => (
            <button
              key={id}
              onClick={() => saveQuant(preset.values)}
              title={preset.blurb}
              className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:border-accent hover:text-accent"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Presets overwrite the values they cover. {TUNING_PRESETS.balanced.blurb}
        </p>

        <div className="mt-4 space-y-3">
          {TUNING_GROUPS.map((group) => {
            const meta = GROUP_META[group];
            const n = changedCount(group);
            const isOpen = open[group] ?? false;
            return (
              <div key={group} className="rounded-lg border border-border">
                <button
                  onClick={() => setOpen((o) => ({ ...o, [group]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <span>
                    <span className="text-sm font-medium">{meta.title}</span>
                    {n > 0 && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{n} changed</span>}
                    <span className="mt-0.5 block text-xs text-muted">{meta.blurb}</span>
                  </span>
                  <span className="shrink-0 text-muted">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && (
                  <div className="border-t border-border px-4 pb-3">
                    {PARAMS_BY_GROUP(group).map((p) => (
                      <TuningRow key={p.key} param={p} tuning={tuning} onChange={saveQuant} />
                    ))}
                    <div className="pt-3">
                      <button onClick={() => resetGroup(group)} className="text-xs text-muted underline underline-offset-2 hover:text-fg">
                        Reset this section to defaults
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Timing</h2>
        <Row label="Start researching" hint="Minutes before the market closes.">
          <Num value={s.minutesBeforeCloseToResearch} onCommit={(v) => save({ minutesBeforeCloseToResearch: v })} suffix="min before close" />
        </Row>
        <Row label="Place the buy order" hint="Minutes before the market closes.">
          <Num value={s.minutesBeforeCloseToBuy} onCommit={(v) => save({ minutesBeforeCloseToBuy: v })} suffix="min before close" />
        </Row>
        <Row label="Approval window">
          <Num value={s.approvalWindowMinutes} onCommit={(v) => save({ approvalWindowMinutes: v })} suffix="min" />
        </Row>
      </section>
    </div>
  );
}
