import { Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { TradeReturnsChart } from "@/components/charts";
import { CalendarHeatmap } from "@/components/viz/CalendarHeatmap";
import { DivergingBars } from "@/components/viz/DivergingBars";
import { ReliabilityChart } from "@/components/viz/ReliabilityChart";
import { ReturnHistogram } from "@/components/visual-panels";
import { pct, tone } from "@/lib/format";
import { getLearning } from "@/lib/queries";

export const dynamic = "force-dynamic";

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export default async function Learning() {
  const { stats, closed, scored, lessons, noTradeDays, model, risk } = await getLearning();
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

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><Stat label="Compounded return" value={risk ? pct(risk.compoundedReturnPct) : "n/a"} tone={tone(risk?.compoundedReturnPct)} sub="closed trades, sequentially compounded" /></Card>
        <Card><Stat label="Maximum drawdown" value={risk ? pct(-risk.maxDrawdownPct) : "n/a"} tone={risk?.maxDrawdownPct ? "bad" : undefined} sub="largest peak-to-trough decline" /></Card>
        <Card><Stat label="Profit factor" value={risk?.profitFactor == null ? "n/a" : risk.profitFactor.toFixed(2)} tone={risk?.profitFactor != null && risk.profitFactor > 1 ? "good" : "bad"} sub="gross gains divided by gross losses" /></Card>
        <Card><Stat label="Worst overnight" value={risk ? pct(risk.worstPct) : "n/a"} tone={tone(risk?.worstPct)} sub={risk ? `best ${pct(risk.bestPct)} · downside deviation ${pct(risk.downsideDeviationPct)}` : undefined} /></Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Return of each trade">
          <TradeReturnsChart data={closed.map((c) => ({ label: c.date.slice(5), pct: c.pnlPct! }))} />
        </Card>

        <Card title="Return distribution">
          <ReturnHistogram values={closed.map((c) => c.pnlPct)} />
        </Card>
      </div>

      <Card className="mt-4" title="Chronological out-of-sample check">
        {!model.walkForward || model.walkForward.n < 20 ? (
          <Empty>Needs at least 20 stored predictions whose probabilities were recorded before the outcome. {model.walkForward ? `${model.walkForward.n} so far.` : ""}</Empty>
        ) : (
          <>
            <div className="table-shell">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr><th className="py-2 font-medium">Slice</th><th className="py-2 text-right font-medium">Cases</th><th className="py-2 text-right font-medium">Model error</th><th className="py-2 text-right font-medium">Base-rate error</th><th className="py-2 text-right font-medium">Model AUC</th><th className="py-2 text-right font-medium">Screener AUC</th></tr>
                </thead>
                <tbody className="tabular divide-y divide-border">
                  {model.walkForward.slices.map((slice) => (
                    <tr key={slice.label}>
                      <td className="py-2">{slice.label}</td>
                      <td className="py-2 text-right">{slice.n}</td>
                      <td className="py-2 text-right">{slice.accuracy?.brier.toFixed(3) ?? "n/a"}</td>
                      <td className="py-2 text-right">{slice.accuracy?.baselineBrier.toFixed(3) ?? "n/a"}</td>
                      <td className="py-2 text-right">{slice.accuracy?.modelAuc?.toFixed(2) ?? "n/a"}</td>
                      <td className="py-2 text-right">{slice.accuracy?.screenerAuc?.toFixed(2) ?? "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted">These are live-era predictions in chronological order: each probability was stored before its next-open outcome. The recent half must continue beating both the base-rate error and the screener before confidence in the model is justified.</p>
          </>
        )}
      </Card>

      <Card className="mt-4" title="Trading calendar">
        <CalendarHeatmap days={closed.map((c) => ({ date: c.date, value: c.pnlPct, label: c.ticker }))} format={(value) => pct(value)} ariaLabel="Closed trade returns by day" />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
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
            <>
              <ReliabilityChart points={model.reliability.filter((b) => b.n > 0)} height={230} />
              <div className="table-shell mt-3">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">It said</th><th className="py-1 text-right font-medium">Actually happened</th><th className="py-1 text-right font-medium">Cases</th></tr></thead>
                  <tbody className="tabular divide-y divide-border">
                    {model.reliability.filter((b) => b.n > 0).map((b) => (
                      <tr key={b.bucket}><td className="py-2">{Math.round(b.predicted * 100)}%</td><td className="py-2 text-right">{Math.round(b.realised * 100)}%</td><td className="py-2 text-right">{b.n}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="mt-3 text-xs text-muted">Each row should read roughly the same left and right. Where it does not, the engine shrinks its own probabilities toward the truth before sizing anything.</p>
        </Card>

        <Card title="What the model weighs">
          {model.learned.length === 0 ? (
            <Empty>Still using its starting priors. Weights move as outcomes arrive.</Empty>
          ) : (
            <>
              <DivergingBars rows={model.learned.map((l) => ({ label: l.label, value: l.weight, reference: l.prior }))} referenceLabel="starting weight" format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`} />
              <div className="table-shell mt-4">
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
              </div>
            </>
          )}
          <p className="mt-3 text-xs text-muted">Positive means the signal argues for taking the trade. A weight that has drifted far from where it started is something the data insisted on.</p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Is the model's judgement real?">
          {!model.accuracy || model.accuracy.n < 20 ? (
            <Empty>Needs about 20 scored candidates that the engine evaluated before this is meaningful. {model.accuracy ? `${model.accuracy.n} so far.` : ""}</Empty>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Probability error" value={model.accuracy.brier.toFixed(3)} sub={`guessing the base rate: ${model.accuracy.baselineBrier.toFixed(3)}`} tone={model.accuracy.brier < model.accuracy.baselineBrier ? "good" : "bad"} />
                <Stat label="Model ranking skill" value={model.accuracy.modelAuc == null ? "n/a" : model.accuracy.modelAuc.toFixed(2)} sub="0.50 means no skill" />
                <Stat label="Screener ranking skill" value={model.accuracy.screenerAuc == null ? "n/a" : model.accuracy.screenerAuc.toFixed(2)} sub="what it must beat" />
              </div>
              <p className="text-xs text-muted">Measured on {model.accuracy.n} shortlisted nights. The model is only adding value when its error is below the base-rate error and its ranking skill is above the screener&apos;s.</p>
            </div>
          )}
        </Card>

        <Card title="History replay">
          {!model.backfill || model.backfill.nights === 0 ? (
            <Empty>Not started yet. Once the study loop has found tradable symbols, their past nights are replayed into the model in spare time.</Empty>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Symbols replayed" value={model.backfill.symbols} />
                <Stat label="Nights learned from" value={model.backfill.nights} />
                <Stat label="Error before learning" value={(model.backfill.brierSum / model.backfill.nights).toFixed(3)} sub={`base rate: ${(model.backfill.baselineBrierSum / model.backfill.nights).toFixed(3)}`} />
              </div>
              <p className="text-xs text-muted">Each batch is scored before the model trains on it, so these figures are honest out-of-sample numbers. Replayed nights carry no headlines or market context, so only the price-based signals learn from them.</p>
            </div>
          )}
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
