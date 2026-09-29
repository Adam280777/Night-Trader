import { Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { TradeReturnsChart } from "@/components/charts";
import { pct, tone } from "@/lib/format";
import { getLearning } from "@/lib/queries";

export const dynamic = "force-dynamic";

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export default function Learning() {
  const { stats, closed, scored, lessons, noTradeDays } = getLearning();
  const pickedAvg = avg(scored.filter((s) => s.picked).map((s) => s.ret!));
  const restAvg = avg(scored.filter((s) => !s.picked).map((s) => s.ret!));
  const allAvg = avg(scored.map((s) => s.ret!));
  const enough = stats.closedTrades >= 20;

  return (
    <>
      <PageHeader title="Learning" subtitle="How the AI is doing and what it has taught itself. Each night's shortlist is scored on what really happened, not only the stock it bought." />
      {!enough && <div className="mb-4"><Notice tone="info">Only {stats.closedTrades} closed trade{stats.closedTrades === 1 ? "" : "s"} so far. Win rates and averages this small are mostly noise. Judge after at least 20 to 30 trades.</Notice></div>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><Stat label="Win rate" value={stats.winRate == null ? "n/a" : `${Math.round(stats.winRate * 100)}%`} sub={`${stats.closedTrades} trades`} /></Card>
        <Card><Stat label="Average trade" value={pct(stats.avgPnlPct)} tone={tone(stats.avgPnlPct)} sub={`wins ${pct(stats.avgWinPct)} · losses ${pct(stats.avgLossPct)}`} /></Card>
        <Card><Stat label="Days sat out" value={noTradeDays} sub="no trade or blocked" /></Card>
        <Card><Stat label="Lessons learned" value={lessons.length} /></Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Return of each trade">
          <TradeReturnsChart data={closed.map((c) => ({ label: c.date.slice(5), pct: c.pnlPct! }))} />
        </Card>

        <Card title="Is the AI beating the shortlist?">
          {scored.length === 0 ? (
            <Empty>Needs at least one completed overnight period.</Empty>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">Average actual overnight return (close to next open, before costs) across {scored.length} scored candidates.</p>
              <div className="grid grid-cols-3 gap-4">
                <Stat label="AI's picks" value={pct(pickedAvg)} tone={tone(pickedAvg)} />
                <Stat label="Not picked" value={pct(restAvg)} tone={tone(restAvg)} />
                <Stat label="Whole shortlist" value={pct(allAvg)} tone={tone(allAvg)} />
              </div>
              <p className="text-xs text-muted">If the AI&apos;s picks do not beat the rest of the shortlist over many days, its research is not adding value and the money is better left alone.</p>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Confidence vs reality">
          {stats.byConfidence.length === 0 ? (
            <Empty>Needs closed trades.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">Stated confidence</th><th className="py-1 text-right font-medium">Trades</th><th className="py-1 text-right font-medium">Win rate</th><th className="py-1 text-right font-medium">Avg return</th></tr></thead>
              <tbody className="tabular divide-y divide-border">
                {stats.byConfidence.map((b) => (
                  <tr key={b.bucket}><td className="py-2">{b.bucket}</td><td className="py-2 text-right">{b.n}</td><td className="py-2 text-right">{Math.round(b.winRate * 100)}%</td><td className="py-2 text-right">{pct(b.avgPnlPct)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-muted">If higher confidence does not mean higher win rate, the AI&apos;s confidence is not informative.</p>
        </Card>

        <Card title="By market">
          {stats.byMarket.length === 0 ? (
            <Empty>Needs closed trades.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">Market</th><th className="py-1 text-right font-medium">Trades</th><th className="py-1 text-right font-medium">Win rate</th><th className="py-1 text-right font-medium">Avg return</th></tr></thead>
              <tbody className="tabular divide-y divide-border">
                {stats.byMarket.map((m) => (
                  <tr key={m.market}><td className="py-2">{m.market}</td><td className="py-2 text-right">{m.n}</td><td className="py-2 text-right">{Math.round(m.winRate * 100)}%</td><td className="py-2 text-right">{pct(m.avgPnlPct)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Lessons the AI wrote for itself">
        {lessons.length === 0 ? (
          <Empty>None yet. After each trade closes, the AI reviews what happened and records what to do differently. These are fed back into every future decision.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {lessons.map((l) => (
              <li key={l.id} className="rounded-lg bg-surface-2 px-3 py-2">
                {l.text}
                {l.tags.length > 0 && <span className="ml-2 text-xs text-muted">{l.tags.join(" · ")}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
