import Link from "next/link";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { AutoRefresh } from "@/components/controls";
import { STATUS, money, pct, tone } from "@/lib/format";
import { getHistory } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function History() {
  const rows = await getHistory(200);
  return (
    <>
      <AutoRefresh seconds={30} />
      <PageHeader title="History" subtitle="Every run, including the days the model chose to sit out. Click a row for its full research and reasoning." />
      <Card>
        {rows.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs tracking-wide text-muted uppercase">
                <tr>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Market</th>
                  <th className="py-2 pr-4 font-medium">Strategy</th>
                  <th className="py-2 pr-4 font-medium">Pick</th>
                  <th className="py-2 pr-4 text-right font-medium">Confidence</th>
                  <th className="py-2 pr-4 text-right font-medium">Result</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ run, decision, trade }) => {
                  const st = STATUS[run.status];
                  return (
                    <tr key={run.id} className="hover:bg-surface-2">
                      <td className="py-2.5 pr-4"><Link href={`/history/${run.id}`} className="font-medium text-accent hover:underline">{run.tradingDate}</Link></td>
                      <td className="py-2.5 pr-4">{run.market} <span className="text-xs text-muted">{run.mode}</span></td>
                      <td className="py-2.5 pr-4">{run.strategy === "intraday_momentum" ? "Intraday momentum" : "Overnight"}</td>
                      <td className="py-2.5 pr-4">{decision?.action === "BUY" ? decision.name ?? decision.ticker : <span className="text-muted">No trade</span>}</td>
                      <td className="tabular py-2.5 pr-4 text-right">{decision?.confidence != null ? `${Math.round(decision.confidence * 100)}%` : ""}</td>
                      <td className={`tabular py-2.5 pr-4 text-right font-medium ${tone(trade?.pnlPct) === "good" ? "text-accent" : tone(trade?.pnlPct) === "bad" ? "text-danger" : ""}`}>
                        {trade?.status === "closed" ? `${pct(trade.pnlPct)}${trade.pnl != null ? ` (${money(trade.pnl)})` : ""}` : trade ? "open" : ""}
                      </td>
                      <td className="py-2.5 pr-4"><Badge tone={st.tone}>{st.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
