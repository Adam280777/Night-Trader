import { AlertTriangle, CheckCircle2, Clock3 } from "lucide-react";
import { BarList } from "@/components/viz/BarList";
import { Donut } from "@/components/viz/Donut";
import { JobDurationChart } from "@/components/visual-panels";
import { Badge, Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { pct, when } from "@/lib/format";
import { getSystemDiagnostics, getWorkerStatus } from "@/lib/queries";
import { settingsIssues } from "@/lib/settings-checks";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  const diagnostics = await getSystemDiagnostics();
  const worker = await getWorkerStatus(diagnostics.settings.ops.workerStaleMinutes);
  const issues = settingsIssues(diagnostics.settings);

  return (
    <>
      <PageHeader
        title="System health"
        subtitle="Long-running operational health, job duration, storage growth and configuration checks. Use this page with Logs when diagnosing a failure."
        right={<Badge tone={worker.alive ? "good" : "bad"}>{worker.alive ? "Worker online" : "Worker offline"}</Badge>}
      />

      {!worker.alive && (
        <div className="mb-4">
          <Notice tone="bad">No scheduler heartbeat within {diagnostics.settings.ops.workerStaleMinutes} minutes. The trading pipeline is not progressing.</Notice>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><Stat label="Recent job success" value={diagnostics.successRate == null ? "n/a" : pct(diagnostics.successRate * 100)} tone={diagnostics.successRate != null && diagnostics.successRate >= 0.98 ? "good" : "warn"} sub={`last ${diagnostics.jobs.length} recorded jobs`} /></Card>
        <Card><Stat label="Recent failures" value={diagnostics.failures} tone={diagnostics.failures ? "bad" : "good"} /></Card>
        <Card><Stat label="Average job duration" value={diagnostics.averageDurationMs == null ? "n/a" : `${(diagnostics.averageDurationMs / 1000).toFixed(1)}s`} /></Card>
        <Card><Stat label="Last heartbeat" value={worker.lastHeartbeat ? when(new Date(worker.lastHeartbeat)) : "never"} /></Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Background job duration">
          <JobDurationChart
            jobs={diagnostics.jobs.map((job) => ({ ts: job.startedAt.getTime(), seconds: job.durationMs / 1000 }))}
            slowSeconds={diagnostics.settings.ops.slowJobSeconds}
          />
        </Card>
        <Card title="Logs in the last 24 hours">
          <Donut
            segments={diagnostics.levelCounts.map((item) => ({ ...item, tone: item.label === "error" ? "bad" : item.label === "warn" ? "warn" : "info" }))}
            centre={diagnostics.levelCounts.reduce((sum, item) => sum + item.value, 0)}
            centreLabel="events"
            ariaLabel="Log levels in the last 24 hours"
          />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Latest job by type">
          {diagnostics.latest.length === 0 ? (
            <Empty>No background job records yet.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {diagnostics.latest.map((job) => (
                <li key={job.job} className="flex flex-wrap items-center gap-3 py-2">
                  {job.ok ? <CheckCircle2 className="size-4 text-accent" aria-hidden /> : <AlertTriangle className="size-4 text-danger" aria-hidden />}
                  <span className="min-w-32 flex-1 font-medium">{job.job}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted"><Clock3 className="size-3" aria-hidden />{(job.durationMs / 1000).toFixed(1)}s</span>
                  <span className="tabular text-xs text-muted">{when(job.startedAt)}</span>
                  {job.error && <span className="w-full pl-7 text-xs text-danger">{job.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Stored operational data">
          <BarList items={diagnostics.counts.map((item) => ({ label: item.label, value: item.value, display: item.value.toLocaleString() }))} tone="palette" ariaLabel="Database row counts" />
          <p className="mt-3 text-xs text-muted">Logs, job records, and equity snapshots are automatically pruned using the retention values in Settings. Trading history and learned model data are preserved.</p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><Stat label="Measured fills" value={diagnostics.execution.measuredFills} sub={`${diagnostics.execution.orders} recent order records`} /></Card>
        <Card><Stat label="Average adverse slippage" value={diagnostics.execution.averageSlippagePct == null ? "n/a" : pct(diagnostics.execution.averageSlippagePct)} tone={diagnostics.execution.averageSlippagePct != null && diagnostics.execution.averageSlippagePct > diagnostics.settings.ops.maxSlippagePct ? "bad" : undefined} sub={`95th percentile ${diagnostics.execution.p95SlippagePct == null ? "n/a" : pct(diagnostics.execution.p95SlippagePct)}`} /></Card>
        <Card><Stat label="Average quoted spread" value={diagnostics.execution.averageSpreadPct == null ? "n/a" : pct(diagnostics.execution.averageSpreadPct)} sub="when Yahoo supplied bid and ask" /></Card>
        <Card><Stat label="Order issue rate" value={diagnostics.execution.issueRate == null ? "n/a" : pct(diagnostics.execution.issueRate * 100)} tone={diagnostics.execution.issueRate ? "bad" : "good"} sub={`${diagnostics.execution.rejected} rejected · ${diagnostics.execution.unknown} unknown · ${diagnostics.execution.partial} partial · ${diagnostics.execution.cancelled} cancelled`} /></Card>
      </div>

      <Card className="mt-4" title="Independent monitoring">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-surface-2 p-3">
            <div className="text-sm font-medium">Critical-error webhook</div>
            <p className="mt-1 text-xs text-muted">{diagnostics.alerting.webhookConfigured ? "Configured. Critical errors are delivered and deduplicated for 30 minutes." : "Not configured. Set ALERT_WEBHOOK_URL to receive failures outside the dashboard."}</p>
          </div>
          <div className="rounded-lg bg-surface-2 p-3">
            <div className="text-sm font-medium">External health check</div>
            <p className="mt-1 text-xs text-muted">Monitor <code className="font-mono">/api/health</code> for non-200 responses. {diagnostics.alerting.healthProtected ? "Bearer protection is enabled." : "Set HEALTH_SECRET before exposing detailed monitoring."}</p>
          </div>
        </div>
      </Card>

      <Card className="mt-4" title="Configuration checks">
        {issues.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-accent"><CheckCircle2 className="size-4" aria-hidden />No conflicting or risky setting combinations detected.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {issues.map((issue, index) => (
              <li key={`${issue.field}-${index}`} className={issue.level === "warn" ? "text-warn" : "text-info"}>{issue.message}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
