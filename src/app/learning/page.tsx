import { Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { TradeReturnsChart } from "@/components/charts";
import { pct, tone } from "@/lib/format";
import { getLearning } from "@/lib/queries";

export const dynamic = "force-dynamic";

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export default async function Learning() {
  const { stats, closed, scored, lessons, noTradeDays, model } = await getLearning();
  const pickedAvg = avg(scored.filter((s) => s.picked).map((s) => s.ret!));
  const restAvg = avg(scored.filter((s) => !s.picked).map((s) => s.ret!));
  const allAvg = avg(scored.map((s) => s.ret!));
  const enough = stats.closedTrades >= 20;

  return (
    <>
      <PageHeader title="Learning" subtitle="How the decision model is doing and what it has taught itself. Each night's shortlist is scored on what really happened, not only the stock it bought." />
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

        <Card title="Is the model beating the shortlist?">
          {scored.length === 0 ? (
            <Empty>Needs at least one completed overnight period.</Empty>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted">Average actual overnight return (close to next open, before costs) across {scored.length} scored candidates.</p>
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Its picks" value={pct(pickedAvg)} tone={tone(pickedAvg)} />
                <Stat label="Not picked" value={pct(restAvg)} tone={tone(restAvg)} />
                <Stat label="Whole shortlist" value={pct(allAvg)} tone={tone(allAvg)} />
              </div>
              <p className="text-xs text-muted">If the picks do not beat the rest of the shortlist over many days, the engine is not adding value and the money is better left alone.</p>
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
          <p className="mt-3 text-xs text-muted">If higher confidence does not mean higher win rate, the stated confidence is not informative.</p>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Model calibration">
          <div className="mb-3 grid grid-cols-3 gap-4">
            <Stat label="Trained on" value={model.samples} sub="outcomes" />
            <Stat label="Labelled rows" value={model.labelledRows} sub="shortlist history" />
            <Stat label="Calibration error" value={model.calibrationError == null ? "n/a" : `${(model.calibrationError * 100).toFixed(1)}pp`} sub="predicted vs actual" />
          </div>
          {model.reliability.filter((b) => b.n > 0).length === 0 ? (
            <Empty>Needs more scored candidates before a reliability curve means anything.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">It said</th><th className="py-1 text-right font-medium">Actually happened</th><th className="py-1 text-right font-medium">Cases</th></tr></thead>
              <tbody className="tabular divide-y divide-border">
                {model.reliability.filter((b) => b.n > 0).map((b) => (
                  <tr key={b.bucket}><td className="py-2">{Math.round(b.predicted * 100)}%</td><td className="py-2 text-right">{Math.round(b.realised * 100)}%</td><td className="py-2 text-right">{b.n}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-muted">Each row should read roughly the same left and right. Where it does not, the engine shrinks its own probabilities toward the truth before sizing anything.</p>
        </Card>

        <Card title="What the model weighs">
          {model.learned.length === 0 ? (
            <Empty>Still using its starting priors. Weights move as outcomes arrive.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">Signal</th><th className="py-1 text-right font-medium">Weight now</th><th className="py-1 text-right font-medium">Started at</th></tr></thead>
              <tbody className="tabular divide-y divide-border">
                {model.learned.map((l) => (
                  <tr key={l.key}>
                    <td className="py-2">{l.label}</td>
                    <td className={`py-2 text-right ${l.weight >= 0 ? "text-accent" : "text-danger"}`}>{l.weight >= 0 ? "+" : ""}{l.weight.toFixed(2)}</td>
                    <td className="py-2 text-right text-muted">{l.prior >= 0 ? "+" : ""}{l.prior.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-muted">Positive means the signal argues for taking the trade. A weight that has drifted far from where it started is something the data insisted on.</p>
        </Card>
      </div>

      <Card className="mt-4" title="Rules it derived from its own outcomes">
        {lessons.length === 0 ? (
          <Empty>None yet. After each trade closes the result is recorded, and rules are re-derived from the whole outcome history once a pattern is statistically significant.</Empty>
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
