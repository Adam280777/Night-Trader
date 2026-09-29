"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Settings } from "@/lib/config";

interface Props {
  settings: Settings;
  t212Env: "demo" | "live";
  hasT212Keys: boolean;
  hasOpenAI: boolean;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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
    <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-accent" : "bg-border"}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function Num({ value, onCommit, step = 1, suffix }: { value: number; onCommit: (v: number) => void; step?: number; suffix?: string }) {
  const [v, setV] = useState(String(value));
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        step={step}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n !== value) onCommit(n);
          else setV(String(value));
        }}
        className="tabular w-24 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-right text-sm outline-none focus:border-accent"
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}

export function SettingsForm({ settings, t212Env, hasT212Keys, hasOpenAI }: Props) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");

  async function save(patch: Record<string, unknown>) {
    setMsg(null);
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (!r.ok) return setMsg({ ok: false, text: j.error ?? "Could not save" });
    setS(j);
    setMsg({ ok: true, text: "Saved" });
    router.refresh();
  }

  const asPct = (v: number) => Math.round(v * 1000) / 10;

  return (
    <div className="space-y-6">
      {msg && <p role="status" className={`text-sm ${msg.ok ? "text-accent" : "text-danger"}`}>{msg.text}</p>}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Trading mode</h2>
        <Row label="Connection" hint="Change these in API connections above.">
          <span className="text-sm">
            Trading 212 <b>{t212Env}</b> · keys {hasT212Keys ? "found" : <b className="text-danger">missing</b>} · OpenAI key {hasOpenAI ? "found" : <b className="text-danger">missing</b>}
          </span>
        </Row>
        <Row label="Place orders" hint="Off = dry run: the AI does all its research and decisions, and results are simulated from real prices. No orders are sent.">
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
          <Toggle on={s.markets.US} onChange={(v) => save({ markets: { ...s.markets, US: v } })} label="US market" />
        </Row>
        <Row label="UK market" hint="UK buys pay 0.5% stamp duty, so the AI needs a higher confidence and bigger expected move.">
          <Toggle on={s.markets.UK} onChange={(v) => save({ markets: { ...s.markets, UK: v } })} label="UK market" />
        </Row>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Safety limits (the AI cannot override these)</h2>
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
        <Row label="Minimum confidence (US)" hint="The AI's own confidence must be at least this.">
          <Num value={asPct(s.minConfidence)} step={5} suffix="%" onCommit={(v) => save({ minConfidence: v / 100 })} />
        </Row>
        <Row label="Minimum confidence (UK)">
          <Num value={asPct(s.ukMinConfidence)} step={5} suffix="%" onCommit={(v) => save({ ukMinConfidence: v / 100 })} />
        </Row>
        <Row label="Minimum expected edge" hint="Expected overnight move must beat estimated round-trip costs by this many percentage points.">
          <Num value={s.minExpectedEdgePct} step={0.1} suffix="%" onCommit={(v) => save({ minExpectedEdgePct: v })} />
        </Row>
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
