import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader, Stat } from "@/components/ui";
import { ApprovalButtons } from "@/components/controls";
import { STATUS, money, pct, tone, when } from "@/lib/format";
import { getRunDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Research = {
  summary?: string;
  catalysts?: string[];
  risks?: string[];
  sentiment?: string;
  overnightRiskFlags?: string[];
  citations?: { title: string; url: string }[];
};

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getRunDetail(Number(id));
  if (!d) notFound();
  const { run, decision, trade, candidates, orders, events, lessons } = d;
  const st = STATUS[run.status];

  return (
    <>
      <Link href="/history" className="mb-3 inline-block text-sm text-muted hover:text-fg">Back to history</Link>
      <PageHeader title={`${run.market} · ${run.tradingDate}`} subtitle={run.error ?? st.hint} right={<Badge tone={st.tone}>{st.label}</Badge>} />

      {decision && (
        <Card title="Decision" className="mb-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-xl font-semibold">{decision.action === "BUY" ? decision.name ?? decision.ticker : "No trade today"}</div>
              {decision.action === "BUY" && <div className="tabular text-sm text-muted">Confidence {Math.round((decision.confidence ?? 0) * 100)}% · expects {pct(decision.expectedMovePct)} · asked to invest {Math.round((decision.investPct ?? 0) * 100)}% of free cash</div>}
            </div>
            <p className="text-sm">{decision.thesis}</p>
            {decision.risks && <p className="text-sm text-muted"><b>Risks:</b> {decision.risks}</p>}
            {decision.exitPlan && <p className="text-sm text-muted"><b>Exit plan:</b> {decision.exitPlan}</p>}
            {run.status === "awaiting_approval" && decision.approval === "pending" && <ApprovalButtons decisionId={decision.id} deadline={decision.approvalDeadline?.getTime() ?? null} />}
            {decision.guardrailNotes && decision.guardrailNotes.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Guardrails</h3>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">{decision.guardrailNotes.map((n, i) => <li key={i} className={n.startsWith("BLOCKED") ? "text-danger" : ""}>{n}</li>)}</ul>
              </div>
            )}
            {decision.sources && decision.sources.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Sources</h3>
                <ul className="space-y-0.5 text-sm">
                  {decision.sources.map((s) => (
                    <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener" className="text-info hover:underline">{s.title || s.url}</a></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {trade && (
        <Card title="Trade" className="mb-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Result" value={trade.status === "closed" ? pct(trade.pnlPct) : "Open"} tone={tone(trade.pnlPct)} sub={trade.pnl != null ? money(trade.pnl) : undefined} />
            <Stat label="Bought" value={trade.entryPrice?.toFixed(2) ?? "n/a"} sub={`${trade.quantity} @ ${when(trade.entryAt)}`} />
            <Stat label="Sold" value={trade.exitPrice?.toFixed(2) ?? "n/a"} sub={when(trade.exitAt)} />
          </div>
          {trade.review && <p className="mt-4 rounded-lg bg-surface-2 p-3 text-sm"><b>Post-mortem:</b> {trade.review}</p>}
          {lessons.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{lessons.map((l) => <li key={l.id}>{l.text}</li>)}</ul>
          )}
        </Card>
      )}

      <Card title={`Candidates considered (${candidates.length})`} className="mb-4">
        <div className="space-y-3">
          {candidates.map((c) => {
            const r = c.research as Research | null;
            return (
              <details key={c.id} className="rounded-lg border border-border p-3" open={c.picked}>
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{c.name ?? c.ticker} <span className="font-mono text-xs text-muted">{c.ticker}</span>{c.picked && <span className="ml-2"><Badge tone="good">Picked</Badge></span>}</span>
                  <span className="tabular text-xs text-muted">
                    Screen score {c.screenScore?.toFixed(1) ?? "n/a"}
                    {c.overnightReturnPct != null && <> · actual overnight <b className={c.overnightReturnPct >= 0 ? "text-accent" : "text-danger"}>{pct(c.overnightReturnPct)}</b></>}
                  </span>
                </summary>
                <div className="mt-3 space-y-2 text-sm">
                  {r?.summary && <p>{r.summary}</p>}
                  {!r?.summary && c.researchSummary && <p className="text-muted">{c.researchSummary}</p>}
                  {r?.catalysts && r.catalysts.length > 0 && <p><b>Catalysts:</b> {r.catalysts.join("; ")}</p>}
                  {r?.risks && r.risks.length > 0 && <p className="text-muted"><b>Risks:</b> {r.risks.join("; ")}</p>}
                  {c.researchSummary?.startsWith("Not chosen") && r?.summary && <p className="text-muted">{c.researchSummary}</p>}
                </div>
              </details>
            );
          })}
        </div>
      </Card>

      {orders.length > 0 && (
        <Card title="Orders" className="mb-4">
          <ul className="divide-y divide-border text-sm">
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>{o.side} {o.quantity} {o.ticker}</span>
                <span className="text-muted">{o.status}{o.error ? ` · ${o.error}` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Log">
        <ul className="divide-y divide-border text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3 py-1.5">
              <span className="tabular w-28 shrink-0 text-xs text-muted">{when(e.ts)}</span>
              <span className={e.level === "error" ? "text-danger" : e.level === "warn" ? "text-warn" : ""}>{e.message}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
