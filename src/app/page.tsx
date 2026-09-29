import Link from "next/link";
import { Check } from "lucide-react";
import { Badge, Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { ApprovalButtons, AutoRefresh, KillSwitch, ResolveOrderButton } from "@/components/controls";
import { EquityChart } from "@/components/charts";
import { STATUS, money, pct, tone, when } from "@/lib/format";
import { getAccountSafe, getEnvStatus, getEquitySeries, getFeaturedRun, getOpenTrade, getPnlWindows, getRecentEvents, getUnknownOrders, getWorkerStatus } from "@/lib/queries";
import { currentMode, getSettings } from "@/lib/config";
import { getPerformanceStats } from "@/lib/ai/memory";
export const dynamic = "force-dynamic";

const STEPS = ["Screen", "Research", "Decide", "Approve", "Buy", "Hold", "Sell"];
const STEP_INDEX: Record<string, number> = {
  scheduled: 0, screening: 0, researching: 1, deciding: 2, awaiting_approval: 3, ready_to_buy: 3, executing: 4, holding: 5, exiting: 6, closed: 7,
};

function Timeline({ status }: { status: string }) {
  const current = STEP_INDEX[status];
  if (current == null) return null;
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="flex items-center gap-1">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${done ? "bg-accent-soft text-accent" : active ? "bg-info-soft text-info ring-1 ring-info" : "bg-surface-2 text-muted"}`}>
              {done && <Check className="size-3" aria-hidden />}
              {s}
            </span>
            {i < STEPS.length - 1 && <span className="h-px w-3 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export default async function Dashboard() {
  const settings = await getSettings();
  const [env, worker, acctRes, featured, open, unknown, stats, events, equityRows, mode] = await Promise.all([
    getEnvStatus(),
    getWorkerStatus(),
    getAccountSafe(),
    getFeaturedRun(),
    getOpenTrade(),
    getUnknownOrders(),
    getPerformanceStats(),
    getRecentEvents(12),
    getEquitySeries(),
    currentMode(settings),
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
        subtitle="One stock, bought shortly before the close and sold at the next open."
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
        {!env.hasOpenAI && <Notice tone="bad">No OpenAI API key is set (add it in Settings), so the AI cannot research or decide.</Notice>}
        {!env.hasT212Keys && <Notice tone="warn">Trading 212 keys are missing (add them in Settings). The stock universe and market schedule come from Trading 212, so the AI cannot run yet.</Notice>}
        {acctError && <Notice tone="warn">Could not read your Trading 212 account: {acctError}</Notice>}
        {settings.killSwitch && <Notice tone="warn">Kill switch is ON. No new trades will be started. An open position will still be sold at the next open.</Notice>}
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
        <Card className="lg:col-span-2" title={run ? `${run.market} run · ${run.tradingDate}` : "Today"} action={st && <Badge tone={st.tone}>{st.label}</Badge>}>
          {!run ? (
            <Empty>Nothing yet. The AI starts researching about {settings.minutesBeforeCloseToResearch} minutes before the next market close ({[settings.markets.US && "US", settings.markets.UK && "UK"].filter(Boolean).join(" and ")}).</Empty>
          ) : (
            <div className="space-y-4">
              <Timeline status={run.status} />
              <p className="text-sm text-muted">{st?.hint}{run.error ? ` ${run.error}` : ""}</p>
              {decision && decision.action === "BUY" && (
                <div className="rounded-lg bg-surface-2 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-lg font-semibold">{decision.name ?? decision.ticker} <span className="font-mono text-sm text-muted">{decision.ticker}</span></div>
                    <div className="tabular text-sm text-muted">
                      Confidence {Math.round((decision.confidence ?? 0) * 100)}% · expects {pct(decision.expectedMovePct)} overnight
                    </div>
                  </div>
                  <p className="mt-2 text-sm">{decision.thesis}</p>
                  {decision.risks && <p className="mt-2 text-sm text-muted"><b>Risks:</b> {decision.risks}</p>}
                  {run.status === "awaiting_approval" && decision.approval === "pending" && (
                    <div className="mt-4"><ApprovalButtons decisionId={decision.id} deadline={decision.approvalDeadline?.getTime() ?? null} /></div>
                  )}
                </div>
              )}
              {decision && decision.action === "NO_TRADE" && <p className="rounded-lg bg-surface-2 p-4 text-sm"><b>The AI sat this one out.</b> {decision.thesis}</p>}
              <Link href={`/history/${run.id}`} className="inline-block text-sm font-medium text-accent hover:underline">See full research and reasoning</Link>
            </div>
          )}
        </Card>

        <Card title="Current position">
          {!open ? (
            <Empty>Not holding anything. Positions are opened shortly before the close and sold at the next open.</Empty>
          ) : (
            <div className="space-y-2">
              <div className="text-lg font-semibold">{open.trade.name ?? open.trade.ticker}</div>
              <div className="font-mono text-xs text-muted">{open.trade.ticker}</div>
              <dl className="tabular grid grid-cols-2 gap-y-1 pt-2 text-sm">
                <dt className="text-muted">Quantity</dt><dd className="text-right">{open.trade.quantity}</dd>
                <dt className="text-muted">Bought at</dt><dd className="text-right">{open.trade.entryPrice?.toFixed(2)}</dd>
                <dt className="text-muted">Bought</dt><dd className="text-right">{when(open.trade.entryAt)}</dd>
              </dl>
              {open.decision?.exitPlan && <p className="pt-2 text-sm text-muted">{open.decision.exitPlan}</p>}
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Account value"><EquityChart data={equity} currency={ccy} /></Card>

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
