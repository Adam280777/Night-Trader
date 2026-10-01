import { Card, Empty, Notice, PageHeader, Stat } from "@/components/ui";
import { TradeReturnsChart } from "@/components/charts";
import { CalendarHeatmap } from "@/components/viz/CalendarHeatmap";
import { DivergingBars } from "@/components/viz/DivergingBars";
import { ReliabilityChart } from "@/components/viz/ReliabilityChart";
import { ReturnHistogram } from "@/components/visual-panels";
import { pct, tone } from "@/lib/format";
import { getLearning } from "@/lib/queries";
import { ModelGovernanceControls } from "./model-governance-controls";

export const dynamic = "force-dynamic";

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export default async function Learning() {
  const { stats, closed, scored, lessons, noTradeDays, model, attribution, dailyReviews, governanceReports, risk } = await getLearning();
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

      <Card className="mt-4" title="Advisory promotion readiness">
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">
              {model.promotion.status === "ready_for_review"
                ? "Evidence threshold met — human review may be warranted"
                : model.promotion.status === "needs_improvement"
                  ? "Not ready — measured quality needs improvement"
                  : "Not ready — insufficient live evidence"}
            </p>
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">Read-only advisory</span>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {model.promotion.checks.map((check) => (
              <div key={check.key} className="rounded-lg bg-surface-2 px-3 py-3">
                <p className={check.passed ? "text-sm text-accent" : "text-sm text-danger"}>{check.passed ? "Pass" : "Not met"} · {check.label}</p>
                <p className="mt-1 text-xs text-muted">{check.detail}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">This panel never promotes a model, changes settings, sizes a position, or alters trading. It only summarizes live, chronologically stored evidence for operator review.</p>
        </div>
      </Card>

      <Card className="mt-4" title="Governed model deployments">
        {governanceReports.length === 0 ? (
          <Empty>No governed model deployment is available.</Empty>
        ) : (
          <div className="space-y-5">
            <Notice tone="info">Governance comparisons use matched champion/challenger model evidence only. They are statistically and visually separate from live, demo, dry, and backfill execution results. Promotion is always a confirmed manual action; there is no automatic promotion.</Notice>
            {governanceReports.map((report) => {
              const comparisonRole = report.previousChampionVersionId ? "Previous champion" : "Challenger";
              const promotionAvailable = report.challengerVersionId != null && report.previousChampionVersionId == null;
              const readiness = !promotionAvailable
                ? report.previousChampionVersionId
                  ? "Rollback monitoring — promotion unavailable"
                  : "No challenger assigned"
                : report.readyForManualPromotion
                  ? "Thresholds met — eligible for explicit operator review"
                  : "Not ready for manual promotion";
              const rollbackStatus = report.previousChampionVersionId == null
                ? "Inactive — no previous champion is retained for automatic rollback"
                : report.outcomes < report.thresholds.rollbackOutcomes
                  ? `Monitoring — ${report.outcomes}/${report.thresholds.rollbackOutcomes} matched outcomes before deterioration checks`
                  : "Eligible for the next automatic deterioration check; rollback occurs only if a configured delta is breached";
              const metric = (value: number | null, format: "decimal" | "percent" = "decimal") =>
                value == null ? "Not measured" : format === "percent" ? `${(value * 100).toFixed(1)}%` : value.toFixed(3);
              const returnPct = (value: number | null) => value == null ? "Not measured" : pct(value);

              return (
                <article key={report.scope} className="rounded-lg border border-border p-4" aria-labelledby={`governance-${report.scope}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 id={`governance-${report.scope}`} className="font-medium">{report.scope === "shared" ? "Shared fallback" : `${report.scope} market`} deployment</h3>
                      <p className="mt-1 text-xs text-muted">Champion v{report.championVersionId} · {comparisonRole.toLowerCase()} {report.challengerVersionId == null ? "not assigned" : `v${report.challengerVersionId}`} · previous champion {report.previousChampionVersionId == null ? "none" : `v${report.previousChampionVersionId}`}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs ${report.readyForManualPromotion && promotionAvailable ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"}`}>{readiness}</span>
                  </div>

                  <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div><dt className="text-xs text-muted">Matched outcomes</dt><dd className="tabular text-lg">{report.outcomes}</dd></div>
                    <div><dt className="text-xs text-muted">Matched days</dt><dd className="tabular text-lg">{report.days}</dd></div>
                    <div><dt className="text-xs text-muted">Promotion minimum</dt><dd className="tabular text-sm">{report.thresholds.promotionOutcomes} outcomes · {report.thresholds.promotionDays} days</dd></div>
                    <div><dt className="text-xs text-muted">Maximum challenger calibration error</dt><dd className="tabular text-lg">{(report.thresholds.maxCalibrationError * 100).toFixed(1)}pp</dd></div>
                  </dl>

                  <div className="table-shell mt-4">
                    <table className="w-full min-w-[820px] text-sm">
                      <caption className="sr-only">{report.scope} matched governance metrics for champion and {comparisonRole.toLowerCase()}</caption>
                      <thead className="text-left text-xs text-muted">
                        <tr>
                          <th scope="col" className="py-2 font-medium">Evidence role</th>
                          <th scope="col" className="py-2 text-right font-medium">Version</th>
                          <th scope="col" className="py-2 text-right font-medium">Calibration error</th>
                          <th scope="col" className="py-2 text-right font-medium">Brier</th>
                          <th scope="col" className="py-2 text-right font-medium">Baseline Brier</th>
                          <th scope="col" className="py-2 text-right font-medium">After-cost return</th>
                          <th scope="col" className="py-2 text-right font-medium">Maximum drawdown</th>
                          <th scope="col" className="py-2 text-right font-medium">Predicted trade frequency</th>
                        </tr>
                      </thead>
                      <tbody className="tabular divide-y divide-border">
                        {[
                          { role: "Champion", version: report.championVersionId, values: report.champion },
                          ...(report.challengerVersionId == null ? [] : [{ role: comparisonRole, version: report.challengerVersionId, values: report.challenger }]),
                        ].map((row) => (
                          <tr key={row.role}>
                            <th scope="row" className="py-2 text-left font-medium">{row.role}</th>
                            <td className="py-2 text-right">v{row.version}</td>
                            <td className="py-2 text-right">{row.values.calibrationError == null ? "Not measured" : `${(row.values.calibrationError * 100).toFixed(1)}pp`}</td>
                            <td className="py-2 text-right">{metric(row.values.brier)}</td>
                            <td className="py-2 text-right">{metric(row.values.baselineBrier)}</td>
                            <td className="py-2 text-right">{returnPct(row.values.meanAfterCostReturnPct)}</td>
                            <td className="py-2 text-right">{returnPct(row.values.maxDrawdownPct)}</td>
                            <td className="py-2 text-right">{metric(row.values.predictedTradeFrequency, "percent")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <section aria-labelledby={`promotion-thresholds-${report.scope}`} className="rounded-lg bg-surface-2 p-3">
                      <h4 id={`promotion-thresholds-${report.scope}`} className="text-sm font-medium">Manual promotion thresholds</h4>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
                        <li>At least {report.thresholds.promotionOutcomes} matched outcomes across {report.thresholds.promotionDays} days.</li>
                        <li>Challenger calibration error no more than {(report.thresholds.maxCalibrationError * 100).toFixed(1)}pp and no worse than champion.</li>
                        <li>Brier no worse than champion and better than its own baseline.</li>
                        <li>After-cost return and drawdown no worse than champion, with trade frequency between 0.25× and 4× champion.</li>
                      </ul>
                    </section>
                    <section aria-labelledby={`rollback-thresholds-${report.scope}`} className="rounded-lg bg-surface-2 p-3">
                      <h4 id={`rollback-thresholds-${report.scope}`} className="text-sm font-medium">Automatic rollback status</h4>
                      <p className="mt-2 text-xs text-muted">{rollbackStatus}.</p>
                      <p className="mt-2 text-xs text-muted">Thresholds: {report.thresholds.rollbackOutcomes} outcomes; Brier +{report.thresholds.rollbackBrierDelta.toFixed(3)}; calibration +{(report.thresholds.rollbackCalibrationDelta * 100).toFixed(1)}pp; after-cost return −{report.thresholds.rollbackReturnDeltaPct.toFixed(2)}pp; drawdown +{report.thresholds.rollbackDrawdownDeltaPct.toFixed(1)}pp.</p>
                    </section>
                  </div>

                  <ModelGovernanceControls
                    scope={report.scope}
                    championVersionId={report.championVersionId}
                    challengerVersionId={report.challengerVersionId}
                    previousChampionVersionId={report.previousChampionVersionId}
                    readyForManualPromotion={report.readyForManualPromotion}
                  />
                </article>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="mt-4" title="Daily after-cost attribution">
        {attribution.execution.length === 0 ? (
          <Empty>Needs a closed trade.</Empty>
        ) : (
          <>
            <div className="table-shell">
              <table className="w-full min-w-[1180px] text-sm">
                <caption className="sr-only">Daily execution attribution with independently covered return, cost, slippage, foreign exchange, benchmark, and cash profit components</caption>
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-2 font-medium">Day / evidence</th>
                    <th scope="col" className="py-2 font-medium">Market / strategy</th>
                    <th scope="col" className="py-2 text-right font-medium">Trades</th>
                    <th scope="col" className="py-2 text-right font-medium">Gross price</th>
                    <th scope="col" className="py-2 text-right font-medium">Observed spread</th>
                    <th scope="col" className="py-2 text-right font-medium">Persisted spread cost</th>
                    <th scope="col" className="py-2 text-right font-medium">UK stamp duty</th>
                    <th scope="col" className="py-2 text-right font-medium">Estimated costs</th>
                    <th scope="col" className="py-2 text-right font-medium">Adverse slippage</th>
                    <th scope="col" className="py-2 text-right font-medium">FX impact cash</th>
                    <th scope="col" className="py-2 text-right font-medium">Market direction</th>
                    <th scope="col" className="py-2 text-right font-medium">Stock selection</th>
                    <th scope="col" className="py-2 text-right font-medium">Net cash P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="tabular divide-y divide-border">
                  {attribution.execution.slice(0, 30).map((row) => {
                    const covered = (value: number | null, n: number) => value == null ? "Not recorded" : `${pct(value)}${n < row.trades ? ` (${n}/${row.trades})` : ""}`;
                    const cash = (value: number | null, n: number) => value == null ? "Not recorded" : `${value >= 0 ? "+" : ""}${value.toFixed(2)} ${row.accountCurrency ?? "currency unknown"}${n < row.trades ? ` (${n}/${row.trades})` : ""}`;
                    const evidence = row.selectionEvidence === "model_selected" ? "model selected" : row.selectionEvidence === "intraday_rules" ? "rules selected" : "exploration override";
                    return (
                    <tr key={`${row.date}:${row.market}:${row.evidenceMode}:${row.strategy}:${row.selectionEvidence}:${row.accountCurrency ?? "unknown"}`}>
                      <th scope="row" className="py-2 pr-3 text-left font-medium">{row.date}<span className="block text-xs font-normal text-muted">{row.evidenceMode.toUpperCase()} · {evidence}</span></th>
                      <td className="py-2">{row.market}<span className="block text-xs text-muted">{row.strategy === "overnight" ? "Overnight" : "Intraday momentum"}</span></td>
                      <td className="py-2 text-right">{row.trades}</td>
                      <td className="py-2 text-right">{covered(row.avgGrossPriceReturnPct, row.coverage.grossPriceReturn)}{row.totalGrossPnl != null && <span className="block text-xs text-muted">{cash(row.totalGrossPnl, row.coverage.grossPnl)} gross cash</span>}</td>
                      <td className="py-2 text-right">{covered(row.avgObservedSpreadPct, row.coverage.observedSpread)}</td>
                      <td className="py-2 text-right">{row.totalEstimatedSpreadCost != null ? cash(row.totalEstimatedSpreadCost, row.coverage.estimatedSpreadCost) : covered(row.avgSpreadCostPct, row.coverage.spreadCost)}</td>
                      <td className="py-2 text-right">{row.totalStampDutyCost != null ? cash(row.totalStampDutyCost, row.coverage.stampDutyCost) : covered(row.avgUkStampDutyPct, row.coverage.ukStampDuty)}</td>
                      <td className="py-2 text-right">{covered(row.avgEstimatedCostPct, row.coverage.estimatedCosts)}</td>
                      <td className="py-2 text-right">{covered(row.avgActualAdverseSlippagePct, row.coverage.adverseSlippage)}{row.totalSlippageCost != null && <span className="block text-xs text-muted">{cash(row.totalSlippageCost, row.coverage.slippageCost)} cash</span>}</td>
                      <td className="py-2 text-right">{row.totalFxImpact != null ? cash(row.totalFxImpact, row.coverage.fxImpactCash) : covered(row.avgFxImpactPct, row.coverage.fxImpact)}</td>
                      <td className="py-2 text-right">{covered(row.avgMarketDirectionContributionPct, row.coverage.benchmark)}</td>
                      <td className="py-2 text-right">{covered(row.avgStockSelectionContributionPct, row.coverage.stockSelection)}</td>
                      <td className="py-2 text-right">{row.totalBrokerNetCashPnl != null
                        ? `${row.totalBrokerNetCashPnl >= 0 ? "+" : ""}${row.totalBrokerNetCashPnl.toFixed(2)} ${row.accountCurrency ?? "currency unknown"} broker (${row.coverage.brokerNetCashPnl}/${row.trades})`
                        : row.totalSimulatedNetCashPnl != null
                        ? `${row.totalSimulatedNetCashPnl >= 0 ? "+" : ""}${row.totalSimulatedNetCashPnl.toFixed(2)} ${row.accountCurrency ?? "currency unknown"} simulated`
                          : "Not recorded"}</td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
            <Notice tone="info">“Not recorded” is never treated as zero. Gross price return is derived only from entry and exit fills. Observed spread is execution context, not claimed cost. Dry cash P&amp;L is labelled simulated; only non-dry broker wallet P&amp;L is labelled broker-authoritative. Component coverage appears as measured/trades.</Notice>
          </>
        )}
      </Card>

      <Card className="mt-4" title="Shadow and historical evidence">
        {attribution.shadow.length === 0 ? (
          <Empty>No scored shadow outcomes yet.</Empty>
        ) : (
          <div className="table-shell">
            <table className="w-full text-sm">
              <caption className="sr-only">Shadow model evidence kept separate from execution performance</caption>
              <thead className="text-left text-xs text-muted"><tr><th scope="col" className="py-2 font-medium">Date</th><th scope="col" className="py-2 font-medium">Market</th><th scope="col" className="py-2 text-right font-medium">Model version</th><th scope="col" className="py-2 text-right font-medium">Cases</th><th scope="col" className="py-2 text-right font-medium">Expected after cost</th><th scope="col" className="py-2 text-right font-medium">Actual after cost</th></tr></thead>
              <tbody className="tabular divide-y divide-border">
                {attribution.shadow.slice(0, 30).map((row) => (
                  <tr key={`${row.date}:${row.market}:${row.modelVersionId}`}>
                    <th scope="row" className="py-2 text-left font-medium">{row.date}<span className="block text-xs font-normal text-muted">SHADOW · dedicated evidence</span></th>
                    <td className="py-2">{row.market}</td><td className="py-2 text-right">v{row.modelVersionId}</td><td className="py-2 text-right">{row.observations}</td><td className="py-2 text-right">{pct(row.avgExpectedAfterCostPct)}</td><td className="py-2 text-right">{pct(row.avgActualAfterCostPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">Shadow rows come only from dedicated model evidence and never enter live, demo, or dry execution totals. Backfill attribution is unavailable because historical candidates are not persisted with execution-equivalent component evidence; it is deliberately not reconstructed or blended.</p>
      </Card>

      <Card className="mt-4" title="Daily operational reviews">
        {dailyReviews.length === 0 ? (
          <Empty>No persisted daily review has been generated yet.</Empty>
        ) : (
          <div className="space-y-4">
            {dailyReviews.slice(0, 3).map((review) => (
              <article key={review.date} className="rounded-lg border border-border p-4" aria-labelledby={`review-${review.date}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 id={`review-${review.date}`} className="font-medium">{review.date} operational review</h3>
                  <p className="text-xs text-muted">Revision {review.revision} · updated {new Date(review.updatedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</p>
                </div>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div><dt className="text-xs text-muted">Candidates considered</dt><dd className="tabular text-lg">{review.totals.consideredCandidates}</dd></div>
                  <div><dt className="text-xs text-muted">Trades</dt><dd className="tabular text-lg">{review.totals.trades}</dd></div>
                  <div><dt className="text-xs text-muted">Abstentions</dt><dd className="tabular text-lg">{review.totals.abstentions}</dd></div>
                  <div><dt className="text-xs text-muted">Guardrail notes shown</dt><dd className="tabular text-lg">{review.guardrails.length}</dd></div>
                  <div><dt className="text-xs text-muted">Failures shown</dt><dd className="tabular text-lg">{review.failures.length}</dd></div>
                </dl>
                {review.trades.length > 0 && (
                  <div className="table-shell mt-3">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Expected and actual movement with broker cash profit and loss for {review.date}</caption>
                      <thead className="text-left text-xs text-muted"><tr><th scope="col" className="py-2 font-medium">Trade</th><th scope="col" className="py-2 font-medium">Evidence</th><th scope="col" className="py-2 text-right font-medium">Expected move</th><th scope="col" className="py-2 text-right font-medium">Actual return</th><th scope="col" className="py-2 text-right font-medium">Broker net cash P&amp;L</th></tr></thead>
                      <tbody className="tabular divide-y divide-border">{review.trades.map((trade, index) => (
                        <tr key={`${trade.ticker}:${index}`}><th scope="row" className="py-2 text-left font-medium">{trade.ticker}</th><td className="py-2">{trade.market} · {trade.strategy.replace("_", " ")} · {trade.mode}</td><td className="py-2 text-right">{pct(trade.expectedMovePct)}</td><td className="py-2 text-right">{pct(trade.actualReturnPct)}</td><td className="py-2 text-right">{trade.brokerNetCashPnl == null ? "Not recorded" : `${trade.brokerNetCashPnl >= 0 ? "+" : ""}${trade.brokerNetCashPnl.toFixed(2)}`}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <section aria-labelledby={`review-controls-${review.date}`}>
                    <h4 id={`review-controls-${review.date}`} className="text-sm font-medium">Controls and data quality</h4>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted">
                      {review.abstentions.slice(0, 4).map((item, index) => <li key={`a:${index}`}>{item.market} {item.strategy.replace("_", " ")} {item.status.replace("_", " ")}: {item.reason}</li>)}
                      {review.guardrails.slice(0, 4).map((item, index) => <li key={`g:${index}`}>{item.market}: {item.note}</li>)}
                      {review.quoteFreshness.map((item) => <li key={item.source}>{item.source}: {item.measured}/{item.observations} quote ages measured{item.maximumAgeMs == null ? "" : `; oldest ${(item.maximumAgeMs / 1000).toFixed(0)}s`}</li>)}
                      <li>Actual adverse slippage measured for {review.coverage.actualSlippage.measured}/{review.coverage.actualSlippage.totalOrders} execution orders{review.slippage.length ? `; average ${(review.slippage.reduce((sum, item) => sum + item.adverseSlippagePct, 0) / review.slippage.length).toFixed(2)}%` : ""}.</li>
                      {review.abstentions.length === 0 && review.guardrails.length === 0 && review.quoteFreshness.length === 0 && <li>No persisted control or freshness evidence.</li>}
                    </ul>
                  </section>
                  <section aria-labelledby={`review-anomalies-${review.date}`}>
                    <h4 id={`review-anomalies-${review.date}`} className="text-sm font-medium">Failures and unusual behavior</h4>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted">
                      {review.failures.slice(0, 4).map((item, index) => <li key={`f:${index}`}>{item.source} ({item.kind.replaceAll("_", " ")}): {item.message}</li>)}
                      {review.unusual.slice(0, 4).map((item, index) => <li key={`u:${index}`}>{item}</li>)}
                      {review.failures.length === 0 && review.unusual.length === 0 && <li>No unusual persisted behavior detected by the review thresholds.</li>}
                    </ul>
                  </section>
                </div>
                <p className="mt-3 text-xs text-muted">Model calibration: {review.model.calibrationError == null ? "not measured" : `${(review.model.calibrationError * 100).toFixed(1)}pp`} from {review.model.samples} samples. Governance comparisons: {review.model.governance.length ? review.model.governance.map((item) => `${item.scope} champion v${item.championVersionId}${item.comparisonVersionId ? ` vs v${item.comparisonVersionId}` : " (no comparator)"}, ${item.outcomes} matched outcomes`).join("; ") : "not available"}.</p>
              </article>
            ))}
          </div>
        )}
      </Card>

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
