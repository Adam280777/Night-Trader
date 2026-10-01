"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Info, SlidersHorizontal } from "lucide-react";
import type { Settings } from "@/lib/config";
import { DEFAULT_TUNING, TUNING_PARAMS } from "@/lib/quant/tuning";
import { settingsIssues } from "@/lib/settings-checks";

interface Props {
  settings: Settings;
  t212Env: "demo" | "live";
  hasT212Keys: boolean;
}

export function Row({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
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

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-border"}`}>
      <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function SymbolList({ value, onCommit, label }: { value: string[]; onCommit: (value: string[]) => void; label: string }) {
  const canonical = value.join(", ");
  const [text, setText] = useState(canonical);
  const [seen, setSeen] = useState(canonical);
  if (seen !== canonical) {
    setSeen(canonical);
    setText(canonical);
  }
  const commit = () => {
    const next = [...new Set(text.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    if (next.length && next.join("|") !== value.join("|")) onCommit(next);
    else setText(canonical);
  };
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      className="w-full max-w-md rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm outline-none focus:border-accent"
    />
  );
}

export function Num({
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

export function SettingsForm({ settings, t212Env, hasT212Keys }: Props) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");

  async function save(patch: Record<string, unknown>) {
    setMsg(null);
    try {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const j = (await r.json()) as Settings & { error?: string };
      if (!r.ok) return setMsg({ ok: false, text: j.error ?? `Could not save (${r.status})` });
      setS(j);
      setMsg({ ok: true, text: "Saved" });
      router.refresh();
    } catch (error) {
      setMsg({ ok: false, text: error instanceof Error ? `Could not save: ${error.message}` : "Could not save" });
    }
  }

  const asPct = (v: number) => Math.round(v * 1000) / 10;
  const tunedCount = TUNING_PARAMS.filter((p) => s.quant[p.key] !== DEFAULT_TUNING[p.key]).length;
  const issues = settingsIssues(s);

  return (
    <div className="space-y-6">
      {msg && <p role="status" className={`text-sm ${msg.ok ? "text-accent" : "text-danger"}`}>{msg.text}</p>}
      {issues.length > 0 && (
        <section aria-labelledby="settings-checks" className="rounded-xl border border-border bg-surface p-4">
          <h2 id="settings-checks" className="text-sm font-semibold">Configuration checks</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {issues.map((issue, index) => {
              const Icon = issue.level === "warn" ? AlertTriangle : Info;
              return (
                <li key={`${issue.field}-${index}`} className={`flex gap-2 ${issue.level === "warn" ? "text-warn" : "text-info"}`}>
                  <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{issue.message}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Platform trading mode</h2>
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
        <Row label="Ask before overnight trades" hint="You approve or reject each overnight proposal. No approval by the deadline means no trade.">
          <Toggle on={s.approvalMode} onChange={(v) => save({ approvalMode: v })} label="Approval mode" />
        </Row>
        <Row label="Overnight strategy" hint="Runs the close-to-next-open model. It shares account risk and execution safety with the intraday strategy.">
          <Toggle on={s.overnightEnabled} onChange={(v) => save({ overnightEnabled: v })} label="Overnight strategy" />
        </Row>
        <Row label="Overnight US market">
          <Toggle on={s.markets.US} onChange={(v) => save({ markets: { US: v } })} label="US market" />
        </Row>
        <Row label="Demo: always make a trade to learn from" hint="Demo mode only. If the engine would pass, it buys its best-ranked unflagged name anyway (no approval needed) so the real fill and overnight move become training data. Never applies in dry-run or live.">
          <Toggle on={s.demoForceTrade} onChange={(v) => save({ demoForceTrade: v })} label="Demo exploration trades" />
        </Row>
        {s.demoForceTrade && (
          <Row label="Demo exploration stake" hint="Share of free cash staked on an exploration trade. The position-size cap below still applies.">
            <Num value={asPct(s.demoForceInvestPct)} step={1} suffix="%" onCommit={(v) => save({ demoForceInvestPct: v / 100 })} />
          </Row>
        )}
        <Row label="Overnight UK market" hint="UK buys pay stamp duty, so a UK candidate has to clear a higher bar before it is worth taking.">
          <Toggle on={s.markets.UK} onChange={(v) => save({ markets: { UK: v } })} label="UK market" />
        </Row>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Intraday momentum strategy</h2>
        <p className="mb-1 text-xs text-muted">
          Uses five-minute Yahoo bars and the shared one-minute scheduler. It only buys long, liquid stocks and manages stop, target, trailing and time exits.
        </p>
        <Row label="Generate intraday signals" hint="Runs scans and dry simulations. This does not grant order permission.">
          <Toggle on={s.intraday.enabled} onChange={(v) => save({ intraday: { enabled: v } })} label="Intraday signals" />
        </Row>
        <Row label="Allow intraday orders" hint="Independent permission for this strategy. Global trading and live confirmation must also be enabled.">
          <Toggle on={s.intraday.ordersEnabled} onChange={(v) => save({ intraday: { ordersEnabled: v } })} label="Intraday orders" />
        </Row>
        <Row label="Ask before intraday trades">
          <Toggle on={s.intraday.approvalMode} onChange={(v) => save({ intraday: { approvalMode: v } })} label="Intraday approval mode" />
        </Row>
        <Row label="Intraday US market">
          <Toggle on={s.intraday.usEnabled} onChange={(v) => save({ intraday: { usEnabled: v } })} label="Intraday US market" />
        </Row>
        <Row label="Intraday UK market">
          <Toggle on={s.intraday.ukEnabled} onChange={(v) => save({ intraday: { ukEnabled: v } })} label="Intraday UK market" />
        </Row>
        <Row label="Stock universe" hint="Automatic rotates through all eligible Trading 212 stocks via continuous study. Hybrid puts manual symbols first; Manual uses only the lists below.">
          <select
            aria-label="Intraday stock universe"
            value={s.intraday.universeMode}
            onChange={(event) => save({ intraday: { universeMode: event.target.value } })}
            className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
          >
            <option value="auto">Automatic full-market discovery</option>
            <option value="hybrid">Automatic plus manual priority</option>
            <option value="manual">Manual symbols only</option>
          </select>
        </Row>
        {s.intraday.universeMode !== "manual" && (
          <>
            <Row label="Automatic candidate pool" hint="Highest-ranked, recently studied stocks retained before live quote filtering.">
              <Num min={10} max={60} value={s.intraday.dynamicUniverseSize} suffix="stocks" onCommit={(v) => save({ intraday: { dynamicUniverseSize: v } })} />
            </Row>
            <Row label="Minimum study observations" hint="How many full-market study rounds must score a stock before automatic selection trusts it.">
              <Num min={1} max={20} value={s.intraday.minUniverseObservations} suffix="observations" onCommit={(v) => save({ intraday: { minUniverseObservations: v } })} />
            </Row>
            <Row label="Maximum knowledge age" hint="Automatically selected names must have been rescored within this period.">
              <Num min={1} max={168} value={s.intraday.universeMaxAgeHours} suffix="hours" onCommit={(v) => save({ intraday: { universeMaxAgeHours: v } })} />
            </Row>
          </>
        )}
        <Row label="Five-minute charts per scan" hint="Fresh quotes rank the full candidate pool first. Only this many expensive intraday histories are downloaded each scan.">
          <Num min={4} max={30} value={s.intraday.maxChartsPerScan} suffix="stocks" onCommit={(v) => save({ intraday: { maxChartsPerScan: v } })} />
        </Row>
        <Row label={s.intraday.universeMode === "manual" ? "US symbols" : "US bootstrap / priority symbols"} hint="Used until automatic study has enough evidence, and always prioritised in Hybrid mode. Yahoo symbols separated by commas.">
          <SymbolList value={s.intraday.usWatchlist} onCommit={(v) => save({ intraday: { usWatchlist: v } })} label="US intraday watchlist" />
        </Row>
        <Row label={s.intraday.universeMode === "manual" ? "UK symbols" : "UK bootstrap / priority symbols"} hint="Use Yahoo's .L suffix for London-listed stocks.">
          <SymbolList value={s.intraday.ukWatchlist} onCommit={(v) => save({ intraday: { ukWatchlist: v } })} label="UK intraday watchlist" />
        </Row>
        <Row label="Scan interval"><Num min={1} max={30} value={s.intraday.scanIntervalMinutes} suffix="minutes" onCommit={(v) => save({ intraday: { scanIntervalMinutes: v } })} /></Row>
        <Row label="Maximum daily intraday trades"><Num min={1} max={10} value={s.intraday.maxTradesPerDay} suffix="trades" onCommit={(v) => save({ intraday: { maxTradesPerDay: v } })} /></Row>
        <Row label="Cooldown after an exit"><Num min={5} max={240} value={s.intraday.cooldownMinutes} suffix="minutes" onCommit={(v) => save({ intraday: { cooldownMinutes: v } })} /></Row>
        <Row label="Start entries after the open"><Num min={15} max={180} value={s.intraday.entryStartMinutesAfterOpen} suffix="minutes" onCommit={(v) => save({ intraday: { entryStartMinutesAfterOpen: v } })} /></Row>
        <Row label="Stop entries before the close"><Num min={30} max={240} value={s.intraday.entryCutoffMinutesBeforeClose} suffix="minutes" onCommit={(v) => save({ intraday: { entryCutoffMinutesBeforeClose: v } })} /></Row>
        <Row label="Maximum hold"><Num min={10} max={240} value={s.intraday.maxHoldMinutes} suffix="minutes" onCommit={(v) => save({ intraday: { maxHoldMinutes: v } })} /></Row>
        <Row label="Position size" hint="Share of available cash requested; shared account caps can reduce it."><Num min={1} max={50} step={1} value={asPct(s.intraday.positionPct)} suffix="%" onCommit={(v) => save({ intraday: { positionPct: v / 100 } })} /></Row>
        <Row label="Stop loss"><Num min={0.2} max={10} step={0.1} value={s.intraday.stopLossPct} suffix="%" onCommit={(v) => save({ intraday: { stopLossPct: v } })} /></Row>
        <Row label="Profit target"><Num min={0.2} max={20} step={0.1} value={s.intraday.takeProfitPct} suffix="%" onCommit={(v) => save({ intraday: { takeProfitPct: v } })} /></Row>
        <Row label="Trailing stop"><Num min={0.1} max={10} step={0.1} value={s.intraday.trailingStopPct} suffix="%" onCommit={(v) => save({ intraday: { trailingStopPct: v } })} /></Row>
        <Row label="Minimum 20-minute momentum"><Num min={0.01} max={10} step={0.05} value={s.intraday.minMomentumPct} suffix="%" onCommit={(v) => save({ intraday: { minMomentumPct: v } })} /></Row>
        <Row label="Maximum 20-minute momentum" hint="Rejects already-exhausted moves."><Num min={0.1} max={20} step={0.1} value={s.intraday.maxMomentumPct} suffix="%" onCommit={(v) => save({ intraday: { maxMomentumPct: v } })} /></Row>
        <Row label="Minimum relative volume"><Num min={0.1} max={10} step={0.1} value={s.intraday.minRelativeVolume} suffix="x" onCommit={(v) => save({ intraday: { minRelativeVolume: v } })} /></Row>
        <Row label="Minimum setup score"><Num min={40} max={95} value={s.intraday.minScore} suffix="/ 100" onCommit={(v) => save({ intraday: { minScore: v } })} /></Row>
        <Row label="Minimum confidence"><Num min={50} max={95} step={1} value={asPct(s.intraday.minConfidence)} suffix="%" onCommit={(v) => save({ intraday: { minConfidence: v / 100 } })} /></Row>
        <Row label="Minimum expected edge after costs"><Num min={0} max={5} step={0.05} value={s.intraday.minExpectedEdgePct} suffix="%" onCommit={(v) => save({ intraday: { minExpectedEdgePct: v } })} /></Row>
        <Row label="Maximum quoted spread"><Num min={0.01} max={5} step={0.05} value={s.intraday.maxSpreadPct} suffix="%" onCommit={(v) => save({ intraday: { maxSpreadPct: v } })} /></Row>
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

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Operations and diagnostics</h2>
        <p className="mb-1 text-xs text-muted">Controls storage growth, worker health thresholds, background cadence and diagnostic detail. These do not change trading decisions.</p>
        <Row label="Keep logs" hint="Detailed application events older than this are removed automatically.">
          <Num min={1} max={365} value={s.ops.logRetentionDays} suffix="days" onCommit={(v) => save({ ops: { logRetentionDays: v } })} />
        </Row>
        <Row label="Keep job diagnostics">
          <Num min={1} max={365} value={s.ops.jobRetentionDays} suffix="days" onCommit={(v) => save({ ops: { jobRetentionDays: v } })} />
        </Row>
        <Row label="Keep account-value history">
          <Num min={7} max={3650} value={s.ops.equityRetentionDays} suffix="days" onCommit={(v) => save({ ops: { equityRetentionDays: v } })} />
        </Row>
        <Row label="Account snapshot interval" hint="Smaller values produce a smoother chart but retain more rows.">
          <Num min={5} max={360} value={s.ops.equitySnapshotMinutes} suffix="minutes" onCommit={(v) => save({ ops: { equitySnapshotMinutes: v } })} />
        </Row>
        <Row label="Outcome check interval">
          <Num min={5} max={1440} value={s.ops.outcomesIntervalMinutes} suffix="minutes" onCommit={(v) => save({ ops: { outcomesIntervalMinutes: v } })} />
        </Row>
        <Row label="Learning interval">
          <Num min={1} max={72} value={s.ops.learningIntervalHours} suffix="hours" onCommit={(v) => save({ ops: { learningIntervalHours: v } })} />
        </Row>
        <Row label="History replay interval">
          <Num min={1} max={240} value={s.ops.backfillIntervalMinutes} suffix="minutes" onCommit={(v) => save({ ops: { backfillIntervalMinutes: v } })} />
        </Row>
        <Row label="Worker offline threshold" hint="The dashboard warns when no scheduler heartbeat arrives within this window.">
          <Num min={2} max={60} value={s.ops.workerStaleMinutes} suffix="minutes" onCommit={(v) => save({ ops: { workerStaleMinutes: v } })} />
        </Row>
        <Row label="Slow job threshold" hint="Jobs exceeding this duration produce a warning with timing context.">
          <Num min={10} max={280} value={s.ops.slowJobSeconds} suffix="seconds" onCommit={(v) => save({ ops: { slowJobSeconds: v } })} />
        </Row>
        <Row label="Maximum US quote age" hint="A buy is blocked when its execution reference quote is older than this.">
          <Num min={30} max={3600} value={s.ops.maxUsQuoteAgeSeconds} suffix="seconds" onCommit={(v) => save({ ops: { maxUsQuoteAgeSeconds: v } })} />
        </Row>
        <Row label="Maximum UK quote age" hint="UK quotes are commonly delayed, so this normally needs a wider window than US quotes.">
          <Num min={60} max={3600} value={s.ops.maxUkQuoteAgeSeconds} suffix="seconds" onCommit={(v) => save({ ops: { maxUkQuoteAgeSeconds: v } })} />
        </Row>
        <Row label="Critical slippage alert" hint="Warn when a broker fill is this much worse than the quote used for sizing.">
          <Num min={0.05} max={10} step={0.05} value={s.ops.maxSlippagePct} suffix="%" onCommit={(v) => save({ ops: { maxSlippagePct: v } })} />
        </Row>
        <Row label="Log successful jobs" hint="Adds a line for every completed job. Leave off for quieter long-term operation; job timings are still recorded.">
          <Toggle on={s.ops.verboseLogging} onChange={(v) => save({ ops: { verboseLogging: v } })} label="Verbose successful job logging" />
        </Row>
      </section>

      <Link
        href="/quant"
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent"
      >
        <span>
          <span className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="size-4 text-accent" aria-hidden />
            Quant settings
          </span>
          <span className="mt-1 block max-w-2xl text-xs text-muted">
            Every number inside the decision engine itself — how it sizes, what it charges for costs, how wide it screens, how
            hard it studies, and what it refuses outright. {tunedCount === 0 ? "All at their shipped values." : `${tunedCount} changed from the shipped values.`}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-muted">
          →
        </span>
      </Link>
    </div>
  );
}
