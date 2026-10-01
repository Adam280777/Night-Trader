import Link from "next/link";
import { Check } from "lucide-react";
import { Badge, Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { ApprovalButtons, AutoRefresh, KillSwitch, ResolveOrderButton } from "@/components/controls";
import { EquityChart } from "@/components/charts";
import { CalendarHeatmap } from "@/components/viz/CalendarHeatmap";
import { Donut } from "@/components/viz/Donut";
import { STATUS, money, pct, tone, when } from "@/lib/format";
import { getAccountSafe, getDashboardInsights, getEnvStatus, getEquitySeries, getFeaturedRun, getOpenTrade, getPnlWindows, getRecentEvents, getUnknownOrders, getWorkerStatus } from "@/lib/queries";
import { currentMode, getSettings } from "@/lib/config";
import { getPerformanceStats } from "@/lib/quant/memory";
export const dynamic = "force-dynamic";

const OVERNIGHT_STEPS = ["Screen", "Research", "Decide", "Approve", "Buy", "Hold", "Sell"];
const INTRADAY_STEPS = ["Scan", "Signal", "Approve", "Buy", "Manage", "Sell"];
const OVERNIGHT_STEP_INDEX: Record<string, number> = {
  scheduled: 0, screening: 0, researching: 1, deciding: 2, awaiting_approval: 3, ready_to_buy: 3, executing: 4, holding: 5, exiting: 6, closed: 7,
};
const INTRADAY_STEP_INDEX: Record<string, number> = {
  awaiting_approval: 2, ready_to_buy: 2, executing: 3, holding: 4, exiting: 5, closed: 6,
};

function Timeline({ status, strategy }: { status: string; strategy: string }) {
  const intraday = strategy === "intraday_momentum";
  const steps = intraday ? INTRADAY_STEPS : OVERNIGHT_STEPS;
  const current = (intraday ? INTRADAY_STEP_INDEX : OVERNIGHT_STEP_INDEX)[status];
  if (current == null) return null;
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex items-center gap-1">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${done ? "bg-accent-soft text-accent" : active ? "bg-info-soft text-info ring-1 ring-info" : "bg-surface-2 text-muted"}`}>
              {done && <Check className="size-3" aria-hidden />}
              {s}
            </span>
            {i < steps.length - 1 && <span className="h-px w-3 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export default async function Dashboard() {
  const settings = await getSettings();
  const [env, worker, acctRes, featured, open, unknown, stats, events, equityRows, mode, insights] = await Promise.all([
    getEnvStatus(),
    getWorkerStatus(settings.ops.workerStaleMinutes),
    getAccountSafe(),
    getFeaturedRun(),
    getOpenTrade(),
    getUnknownOrders(),
    getPerformanceStats(),
    getRecentEvents(12),
    getEquitySeries(),
    currentMode(settings),
    getDashboardInsights(),
  ]);
  const { account, error: acctError } = acctRes;
  const equity = equityRows.map((e) => ({ ts: e.ts.getTime(), value: e.totalValue }));
  const windows = account ? await getPnlWindows(account.totalValue) : null;
  const ccy = account?.currency ?? "GBP";

  const run = featured?.run;
  const decision = featured?.decision;
  const st = run ? STATUS[run.status] : null;

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        title="Dashboard"
        subtitle="One coordinated trading platform: overnight research and low-frequency intraday momentum under shared account-wide safety controls."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={mode === "dry" ? "info" : mode === "demo" ? "warn" : "bad"}>{mode === "dry" ? "Dry run (no orders)" : mode === "demo" ? "Demo account" : "LIVE money"}</Badge>
            <Badge tone={worker.alive ? "good" : "bad"}>{worker.alive ? "Scheduler online" : "Scheduler offline"}</Badge>
            <KillSwitch on={settings.killSwitch} />
          </div>
        }
      />

      <div className="mb-6 space-y-3 empty:hidden">
        {!worker.alive && <Notice tone="bad">The cloud scheduler has not checked in for a few minutes, so nothing will be researched, bought or sold. Check that the external timer (cron-job.org or GitHub Actions) is calling <code className="font-mono">/api/cron/tick</code> every minute.</Notice>}
        {!env.hasT212Keys && <Notice tone="warn">Trading 212 keys are missing (add them in Settings). The stock universe and market schedule come from Trading 212, so no run can start yet.</Notice>}
        {acctError && <Notice tone="warn">Could not read your Trading 212 account: {acctError}</Notice>}
        {settings.killSwitch && <Notice tone="warn">Kill switch is ON. No new trades will be started. Any open position will still be managed to its strategy-defined exit.</Notice>}
        {unknown.map((o) => (
          <Notice key={o.id} tone="bad">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Trading is paused: the outcome of a {o.side} order for {o.ticker} is unknown. Check Trading 212 first.</span>
              <ResolveOrderButton orderId={o.id} />
            </div>
          </Notice>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><Stat label="Account value" value={money(account?.totalValue, ccy)} sub={account?.source === "virtual" ? "Virtual bankroll (no T212 keys)" : `Cash ${money(account?.availableCash, ccy)}`} /></Card>
        <Card><Stat label="Last 24h (realised)" value={windows ? pct(windows.dayPct * 100) : "n/a"} tone={tone(windows?.dayPct)} /></Card>
        <Card><Stat label="Last 7 days (realised)" value={windows ? pct(windows.weekPct * 100) : "n/a"} tone={tone(windows?.weekPct)} /></Card>
        <Card><Stat label="Win rate" value={stats.winRate == null ? "n/a" : `${Math.round(stats.winRate * 100)}%`} sub={`${stats.closedTrades} closed trade${stats.closedTrades === 1 ? "" : "s"}`} /></Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={run ? `${run.strategy === "intraday_momentum" ? "Intraday momentum" : "Overnight"} · ${run.market} · ${run.tradingDate}` : "Today"} action={st && <Badge tone={st.tone}>{st.label}</Badge>}>
          {!run ? (
            <Empty>Nothing yet. The model starts researching about {settings.minutesBeforeCloseToResearch} minutes before the next market close ({[settings.markets.US && "US", settings.markets.UK && "UK"].filter(Boolean).join(" and ")}).</Empty>
          ) : (
            <div className="space-y-4">
              <Timeline status={run.status} strategy={run.strategy} />
              <p className="text-sm text-muted">
                {run.strategy === "intraday_momentum" && run.status === "ready_to_buy" ? "Signal approved; the next tick will recheck shared guardrails and place the entry." : st?.hint}
                {run.error ? ` ${run.error}` : ""}
              </p>
              {decision && decision.action === "BUY" && (
                <div className="rounded-lg bg-surface-2 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-lg font-semibold">{decision.name ?? decision.ticker} <span className="font-mono text-sm text-muted">{decision.ticker}</span>{decision.forced && <span className="ml-2 rounded-full bg-surface px-2 py-0.5 align-middle text-xs font-medium text-muted">demo exploration</span>}</div>
                    <div className="tabular text-sm text-muted">
                      Confidence {Math.round((decision.confidence ?? 0) * 100)}% · expects {pct(decision.expectedMovePct)} {run.strategy === "intraday_momentum" ? "intraday" : "overnight"}
                    </div>
                  </div>
                  <p className="mt-2 text-sm">{decision.thesis}</p>
                  {decision.risks && <p className="mt-2 text-sm text-muted"><b>Risks:</b> {decision.risks}</p>}
                  {run.status === "awaiting_approval" && decision.approval === "pending" && (
                    <div className="mt-4"><ApprovalButtons decisionId={decision.id} deadline={decision.approvalDeadline?.getTime() ?? null} /></div>
                  )}
                </div>
              )}
              {decision && decision.action === "NO_TRADE" && <p className="rounded-lg bg-surface-2 p-4 text-sm"><b>The model sat this one out.</b> {decision.thesis}</p>}
              <Link href={`/history/${run.id}`} className="inline-block text-sm font-medium text-accent hover:underline">See full research and reasoning</Link>
            </div>
          )}
        </Card>

        <Card title="Current position">
          {!open ? (
            <Empty>Not holding anything. Intraday and overnight strategies share the same position and risk controls.</Empty>
          ) : (
            <div className="space-y-2">
              <div className="text-lg font-semibold">{open.trade.name ?? open.trade.ticker}</div>
              <div className="font-mono text-xs text-muted">{open.trade.ticker}</div>
              <dl className="tabular grid grid-cols-2 gap-y-1 pt-2 text-sm">
                <dt className="text-muted">Quantity</dt><dd className="text-right">{open.trade.quantity}</dd>
                <dt className="text-muted">Bought at</dt><dd className="text-right">{open.trade.entryPrice?.toFixed(2)}</dd>
                <dt className="text-muted">Bought</dt><dd className="text-right">{when(open.trade.entryAt)}</dd>
                <dt className="text-muted">Strategy</dt><dd className="text-right">{open.trade.strategy === "intraday_momentum" ? "Intraday" : "Overnight"}</dd>
                {open.trade.stopPrice != null && <><dt className="text-muted">Stop</dt><dd className="text-right">{open.trade.stopPrice.toFixed(2)}</dd></>}
                {open.trade.targetPrice != null && <><dt className="text-muted">Target</dt><dd className="text-right">{open.trade.targetPrice.toFixed(2)}</dd></>}
              </dl>
              {open.decision?.exitPlan && <p className="pt-2 text-sm text-muted">{open.decision.exitPlan}</p>}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {(["overnight", "intraday_momentum"] as const).map((strategy) => {
          const data = insights.strategies.find((item) => item.strategy === strategy);
          const enabled = strategy === "overnight" ? settings.overnightEnabled : settings.intraday.enabled;
          return (
            <Card
              key={strategy}
              title={strategy === "overnight" ? "Overnight strategy" : "Intraday momentum"}
              action={<Badge tone={enabled ? "good" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</Badge>}
            >
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Recent runs" value={data?.runs ?? 0} />
                <Stat label="Closed trades" value={data?.trades ?? 0} />
                <Stat label="Average return" value={pct(data?.averageReturnPct)} tone={tone(data?.averageReturnPct)} sub={data?.winRate == null ? "No evidence yet" : `${Math.round(data.winRate * 100)}% wins`} />
              </div>
              <p className="mt-3 text-xs text-muted">
                {strategy === "overnight"
                  ? `${settings.markets.US ? "US " : ""}${settings.markets.UK ? "UK" : ""} close-to-open model.`
                  : `${settings.intraday.usEnabled ? "US " : ""}${settings.intraday.ukEnabled ? "UK" : ""} ${settings.intraday.universeMode === "manual" ? "manual universe" : "automatic full-market discovery"} every ${settings.intraday.scanIntervalMinutes} minutes; ${settings.intraday.ordersEnabled ? "orders permitted" : "signals and dry simulation only"}.`}
              </p>
            </Card>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Account value"><EquityChart data={equity} currency={ccy} /></Card>
        <Card title="Run outcomes" action={<span className="text-xs text-muted">{insights.totalRuns} recent</span>}>
          <Donut
            segments={insights.statuses.map((item) => ({
              ...item,
              tone: item.label === "closed" ? "good" : item.label === "failed" || item.label === "blocked" ? "bad" : item.label === "no trade" || item.label === "skipped" ? "neutral" : "info",
            }))}
            centre={insights.totalRuns}
            centreLabel="runs"
            size={128}
            ariaLabel="Recent run outcomes"
          />
        </Card>
      </div>

      <Card className="mt-4" title="Daily realised return">
        <CalendarHeatmap days={insights.returns} format={(value) => pct(value)} ariaLabel="Realised trading returns by day" />
      </Card>

      <Card className="mt-4" title="Activity log">
        {events.length === 0 ? (
          <Empty>No activity yet.</Empty>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3 py-2">
                <span className="tabular w-28 shrink-0 text-xs text-muted">{when(e.ts)}</span>
                <span className={e.level === "error" ? "text-danger" : e.level === "warn" ? "text-warn" : ""}>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
