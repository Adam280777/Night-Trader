import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { currentMode, getSettings } from "../lib/config";
import { getDb, schema } from "../lib/db";
import { analyseIntraday } from "../lib/intraday/strategy";
import { selectUniverse, type UniverseSymbol } from "../lib/intraday/universe";
import { overlappingOvernightRun } from "../lib/intraday/coordination";
import { log } from "../lib/log";
import { getIntradayBars, getQuotes, yahooSymbol } from "../lib/market/data";
import type { Session } from "../lib/market/calendar";
import { tradingDateOf } from "../lib/market/sessions";
import { estimatedRoundTripCostPct } from "../lib/risk/guardrails";
import { getInstrumentsCached, marketOf, type Market } from "../lib/t212/instruments";
import { adverseSlippagePct, findHistorical, submitMarketOrder, waitForOrder } from "../lib/t212/safeOrder";
import { tryClient } from "../lib/account";
import { provenSymbols } from "../lib/quant/knowledge";
import { executeBuy } from "./execute";
import { setRunStatus } from "./pipeline";

const { runs, decisions, candidates, trades, orders } = schema;
type Run = typeof runs.$inferSelect;

interface ScanResult {
  created: boolean;
  message: string;
  candidates: number;
  source?: string;
  charted?: number;
}

function insideEntryWindow(session: Session, nowMs: number, afterOpen: number, beforeClose: number) {
  return nowMs >= session.open.getTime() + afterOpen * 60_000 && nowMs < session.close.getTime() - beforeClose * 60_000;
}

async function mapLimited<T, R>(
  rows: T[],
  concurrency: number,
  deadline: number,
  fn: (row: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (next < rows.length && Date.now() < deadline - 16_000) {
        const index = next++;
        results.push(await fn(rows[index]));
      }
    }),
  );
  return results;
}

/** Build a fresh intraday pool from the continuously studied full market, then persist actionable setups. */
export async function scanIntradayMarket(
  market: Market,
  session: Session,
  now = new Date(),
  deadline = Date.now() + 60_000,
): Promise<ScanResult> {
  const settings = await getSettings();
  const tuning = settings.intraday;
  if (!tuning.enabled || (market === "US" ? !tuning.usEnabled : !tuning.ukEnabled)) {
    return { created: false, message: `${market} intraday disabled`, candidates: 0 };
  }
  if (settings.killSwitch) return { created: false, message: "Kill switch is on", candidates: 0 };
  if (!insideEntryWindow(session, now.getTime(), tuning.entryStartMinutesAfterOpen, tuning.entryCutoffMinutesBeforeClose)) {
    return { created: false, message: "Outside the intraday entry window", candidates: 0 };
  }

  const db = getDb();
  const [open] = await db.select({ id: trades.id }).from(trades).where(eq(trades.status, "open")).limit(1);
  if (open) return { created: false, message: "A position is already open", candidates: 0 };
  const upcomingOvernight = await db
    .select({ id: runs.id, sessionCloseAt: runs.sessionCloseAt })
    .from(runs)
    .where(and(
      eq(runs.strategy, "overnight"),
      notInArray(runs.status, ["closed", "no_trade", "blocked", "failed", "skipped"]),
    ));
  const protectedRun = overlappingOvernightRun(
    upcomingOvernight,
    now.getTime(),
    tuning.maxHoldMinutes,
    settings.minutesBeforeCloseToBuy,
  );
  if (protectedRun) {
    return {
      created: false,
      message: `Capital reserved for overnight run #${protectedRun.id}; a new intraday hold could overlap its buy window`,
      candidates: 0,
    };
  }
  const [activeIntraday] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(
      eq(runs.strategy, "intraday_momentum"),
      inArray(runs.status, ["awaiting_approval", "ready_to_buy", "executing", "holding", "exiting"]),
    ))
    .limit(1);
  if (activeIntraday) return { created: false, message: `Intraday run #${activeIntraday.id} is still active`, candidates: 0 };

  const tradingDate = tradingDateOf(market, now);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(trades)
    .innerJoin(runs, eq(trades.runId, runs.id))
    .where(and(eq(runs.strategy, "intraday_momentum"), eq(runs.tradingDate, tradingDate)));
  if (Number(countRow?.count ?? 0) >= tuning.maxTradesPerDay) {
    return { created: false, message: `Daily limit of ${tuning.maxTradesPerDay} intraday trades reached`, candidates: 0 };
  }

  const [latest] = await db
    .select({ exitAt: trades.exitAt })
    .from(trades)
    .where(eq(trades.strategy, "intraday_momentum"))
    .orderBy(desc(trades.id))
    .limit(1);
  if (latest?.exitAt && now.getTime() - latest.exitAt.getTime() < tuning.cooldownMinutes * 60_000) {
    return { created: false, message: "Intraday cooldown is active", candidates: 0 };
  }

  const client = await tryClient();
  if (!client) return { created: false, message: "Trading 212 credentials are required for the instrument map", candidates: 0 };
  const instruments = await getInstrumentsCached(client);
  const marketInstruments = instruments.filter((instrument) => instrument.type === "STOCK" && marketOf(instrument) === market);
  const instrumentByTicker = new Map(marketInstruments.map((instrument) => [instrument.ticker, instrument]));
  const watchlist = market === "US" ? tuning.usWatchlist : tuning.ukWatchlist;
  const wanted = new Set(watchlist.map((symbol) => symbol.toUpperCase()));
  const manual: UniverseSymbol[] = marketInstruments
    .map((instrument) => ({ instrument, symbol: yahooSymbol(instrument) }))
    .filter((row): row is { instrument: (typeof instruments)[number]; symbol: string } => !!row.symbol && wanted.has(row.symbol.toUpperCase()))
    .map(({ instrument, symbol }) => ({ ticker: instrument.ticker, symbol, name: instrument.name, knowledgeScore: 0 }));
  const learnedRows = tuning.universeMode === "manual"
    ? []
    : await provenSymbols(market, {
        minObservations: tuning.minUniverseObservations,
        limit: tuning.dynamicUniverseSize,
        maxAgeHours: tuning.universeMaxAgeHours,
      });
  const learned: UniverseSymbol[] = learnedRows
    .filter((row) => instrumentByTicker.has(row.ticker))
    .map((row) => ({
      ticker: row.ticker,
      symbol: row.symbol,
      name: row.name ?? row.ticker,
      knowledgeScore: row.avgScore ?? row.screenScore ?? 0,
    }));
  const selection = selectUniverse(learned, manual, tuning.universeMode, tuning.dynamicUniverseSize);
  const mapped = selection.symbols.flatMap((row) => {
    const instrument = instrumentByTicker.get(row.ticker);
    return instrument ? [{ ...row, instrument }] : [];
  });
  if (!mapped.length) {
    return { created: false, message: `No ${market} stocks are available in the ${selection.source} intraday pool`, candidates: 0, source: selection.source };
  }

  const quoteMap = await getQuotes(mapped.map((row) => row.symbol), deadline);
  const maxAge = market === "UK" ? settings.ops.maxUkQuoteAgeSeconds : settings.ops.maxUsQuoteAgeSeconds;
  const livePool = mapped
    .flatMap((row) => {
      const quote = quoteMap.get(row.symbol);
      if (!quote || quote.quoteAt == null || now.getTime() - quote.quoteAt > maxAge * 1000) return [];
      if (quote.spreadPct != null && quote.spreadPct > tuning.maxSpreadPct) return [];
      const volumeRatio = quote.avgVolume3m > 0 ? quote.volume / quote.avgVolume3m : 0;
      const dollarVolume = quote.price * quote.volume;
      const preScore =
        Math.max(0, quote.changePct) * 4 +
        Math.min(2, volumeRatio) * 8 +
        Math.max(0, Math.log10(Math.max(1, dollarVolume)) - 5) * 3 +
        row.knowledgeScore * 0.1;
      return [{ ...row, quote, preScore }];
    })
    .sort((a, b) => b.preScore - a.preScore);
  const chartPool = livePool.slice(0, tuning.maxChartsPerScan);
  const evaluations = await mapLimited(
    chartPool,
    4,
    deadline,
    async (row) => {
      try {
        const allBars = await getIntradayBars(row.symbol);
        const bars = allBars.filter((bar) => tradingDateOf(market, bar.date) === tradingDate && bar.date.getTime() <= now.getTime());
        const signal = analyseIntraday(row.symbol, bars, tuning);
        if (!signal) return null;
        return { ...row, signal: { ...signal, price: row.quote.price } };
      } catch (error) {
        await log("warn", "intraday", `Could not evaluate ${row.symbol}: ${String(error).slice(0, 160)}`);
        return null;
      }
    },
  );
  const ranked = evaluations
    .filter((row): row is NonNullable<typeof row> => row != null)
    .sort((a, b) => b.signal.score - a.signal.score);
  const best = ranked[0];
  const charted = evaluations.length;
  if (!best) {
    return {
      created: false,
      message: `No ${market} stock passed after charting ${charted} of ${mapped.length} ${selection.source} candidates`,
      candidates: mapped.length,
      source: selection.source,
      charted,
    };
  }

  const requestedMode = await currentMode(settings);
  const mode = tuning.ordersEnabled ? requestedMode : "dry";
  const approval = mode !== "dry" && tuning.approvalMode ? "pending" : "not_required";
  const approvalDeadline = approval === "pending"
    ? new Date(Math.min(session.close.getTime() - tuning.entryCutoffMinutesBeforeClose * 60_000, now.getTime() + settings.approvalWindowMinutes * 60_000))
    : null;
  const status = approval === "pending" ? "awaiting_approval" : "ready_to_buy";

  const [run] = await db
    .insert(runs)
    .values({
      strategy: "intraday_momentum",
      tradingDate,
      market,
      mode,
      status,
      sessionCloseAt: session.close,
    })
    .returning({ id: runs.id });
  const [decision] = await db
    .insert(decisions)
    .values({
      runId: run.id,
      ticker: best.instrument.ticker,
      name: best.instrument.name,
      action: "BUY",
      confidence: best.signal.confidence,
      investPct: tuning.positionPct,
      thesis: best.signal.reason,
      expectedMovePct: best.signal.expectedMovePct,
      exitPlan: `${tuning.stopLossPct}% stop, ${tuning.takeProfitPct}% target, ${tuning.trailingStopPct}% trailing stop, or ${tuning.maxHoldMinutes} minutes.`,
      risks: "Intraday prices are polled rather than streamed. A fast move can cross an intended exit before the next scheduler tick.",
      approval,
      approvalDeadline,
      marketContext: { strategy: "intraday_momentum", score: best.signal.score },
    })
    .returning({ id: decisions.id });
  await db.insert(candidates).values({
    runId: run.id,
    ticker: best.instrument.ticker,
    name: best.instrument.name,
    screenScore: best.signal.score,
    signals: {
      yahoo: best.symbol,
      price: best.signal.price,
      momentumPct: best.signal.momentumPct,
      breakoutPct: best.signal.breakoutPct,
      relativeVolume: best.signal.relativeVolume,
      vwap: best.signal.vwap,
      emaFast: best.signal.emaFast,
      emaSlow: best.signal.emaSlow,
      spreadPct: best.quote.spreadPct,
    },
    evaluation: best.signal,
    researchSummary: best.signal.reason,
    picked: true,
    refPrice: best.signal.price,
  });
  await log("info", "intraday", `${mode.toUpperCase()} signal #${run.id}: ${best.instrument.ticker} scored ${best.signal.score}/100.`, run.id, {
    decisionId: decision.id,
    symbol: best.symbol,
    signal: best.signal,
    spreadPct: best.quote.spreadPct,
  });
  return {
    created: true,
    message: `Created intraday run #${run.id} from the ${selection.source} pool (${charted} charts from ${mapped.length} candidates)`,
    candidates: mapped.length,
    source: selection.source,
    charted,
  };
}

async function latestDecision(runId: number) {
  return getDb().select().from(decisions).where(eq(decisions.runId, runId)).orderBy(desc(decisions.id)).get();
}

export async function processIntradayRun(run: Run, now = new Date()): Promise<void> {
  const db = getDb();
  const settings = await getSettings();
  if (run.status === "awaiting_approval") {
    const decision = await latestDecision(run.id);
    if (!decision) return setRunStatus(run.id, "failed", "Decision missing");
    if (settings.killSwitch || decision.approval === "rejected") return setRunStatus(run.id, "no_trade", settings.killSwitch ? "Kill switch is on" : "Rejected by you");
    if (decision.approval === "approved") return setRunStatus(run.id, "ready_to_buy");
    if (decision.approvalDeadline && now >= decision.approvalDeadline) {
      await db.update(decisions).set({ approval: "expired" }).where(eq(decisions.id, decision.id));
      return setRunStatus(run.id, "no_trade", "Approval window expired");
    }
    return;
  }
  if (run.status === "ready_to_buy") {
    if (settings.killSwitch) return setRunStatus(run.id, "no_trade", "Kill switch is on");
    if (run.sessionCloseAt && now.getTime() >= run.sessionCloseAt.getTime() - settings.intraday.entryCutoffMinutesBeforeClose * 60_000) {
      return setRunStatus(run.id, "no_trade", "Intraday entry window closed");
    }
    return executeBuy(run.id);
  }
  if (run.status === "holding" || run.status === "exiting") return manageIntradayExit(run, now);
}

async function closeIntradayTrade(
  run: Run,
  trade: typeof trades.$inferSelect,
  exitPrice: number | null,
  exitReason: string,
  realisedPnl: number | null = null,
) {
  const entry = trade.entryPrice;
  const grossPct = exitPrice && entry ? (exitPrice / entry - 1) * 100 : null;
  const cost = estimatedRoundTripCostPct(run.market, (await getSettings()).quant);
  const pnlPct = grossPct == null ? null : run.mode === "dry" ? grossPct - cost : grossPct;
  // Broker wallet impact is authoritative across currencies and fees. Do not invent a cash P&L.
  const pnl = realisedPnl;
  await getDb().update(trades).set({
    status: "closed",
    exitAt: new Date(),
    exitPrice,
    pnlPct,
    pnl,
    exitReason,
    review: `Intraday ${exitReason}: ${pnlPct == null ? "return unavailable" : `${pnlPct.toFixed(2)}% net return`}.`,
  }).where(eq(trades.id, trade.id));
  await setRunStatus(run.id, "closed");
  await log("info", "intraday", `Closed ${trade.ticker} (${exitReason}) at ${exitPrice ?? "unknown"}; ${pnlPct?.toFixed(2) ?? "n/a"}%.`, run.id);
}

async function manageIntradayExit(run: Run, now: Date): Promise<void> {
  const db = getDb();
  const settings = await getSettings();
  const trade = await db.select().from(trades).where(and(eq(trades.runId, run.id), eq(trades.status, "open"))).get();
  if (!trade) return;
  const candidate = await db.select().from(candidates).where(eq(candidates.runId, run.id)).get();
  const symbol = (candidate?.signals as Record<string, string> | null)?.yahoo;
  const quote = symbol ? (await getQuotes([symbol])).get(symbol) : null;
  const maxQuoteAgeSeconds = run.market === "UK" ? settings.ops.maxUkQuoteAgeSeconds : settings.ops.maxUsQuoteAgeSeconds;
  const quoteAgeMs = quote?.quoteAt == null ? null : Math.max(0, now.getTime() - quote.quoteAt);
  const price = quote && quoteAgeMs != null && quoteAgeMs <= maxQuoteAgeSeconds * 1000 ? quote.price : null;
  const highWatermark = Math.max(trade.highWatermark ?? trade.entryPrice ?? 0, price ?? 0);
  if (highWatermark > (trade.highWatermark ?? 0)) {
    await db.update(trades).set({ highWatermark }).where(eq(trades.id, trade.id));
  }

  let reason: string | null = run.status === "exiting" ? run.error : null;
  if (!reason && price != null && trade.stopPrice != null && price <= trade.stopPrice) reason = "stop loss";
  else if (!reason && price != null && trade.targetPrice != null && price >= trade.targetPrice) reason = "profit target";
  else if (
    !reason &&
    price != null &&
    trade.entryPrice != null &&
    highWatermark > trade.entryPrice &&
    trade.trailingStopPct != null &&
    price <= highWatermark * (1 - trade.trailingStopPct / 100)
  ) reason = "trailing stop";
  else if (!reason && trade.plannedExitAt && now >= trade.plannedExitAt) reason = "maximum hold time";
  else if (!reason && run.sessionCloseAt && now.getTime() >= run.sessionCloseAt.getTime() - 15 * 60_000) reason = "session close";

  const sells = await db.select().from(orders).where(and(eq(orders.runId, run.id), eq(orders.side, "SELL"))).orderBy(desc(orders.id));
  const filledSells = sells.filter((order) => (order.filledQuantity ?? 0) > 0);
  const soldQuantity = filledSells.reduce((sum, order) => sum + (order.filledQuantity ?? 0), 0);
  const weightedExitValue = filledSells.reduce((sum, order) => sum + (order.filledQuantity ?? 0) * (order.fillPrice ?? 0), 0);
  const recoveredExitPrice = soldQuantity > 0 && filledSells.every((order) => order.fillPrice != null)
    ? weightedExitValue / soldQuantity
    : null;
  if (soldQuantity >= trade.quantity - 1e-8) {
    await closeIntradayTrade(run, trade, recoveredExitPrice, run.error ?? reason ?? "reconciled filled exit");
    return;
  }
  const working = sells.find((order) => order.status === "sent");
  if (!reason && !working && run.status !== "exiting") return;

  if (run.mode === "dry") {
    if (price != null && reason) await closeIntradayTrade(run, trade, price, reason);
    return;
  }

  const client = await tryClient();
  if (!client) {
    await log("error", "intraday", `Cannot exit ${trade.ticker}: Trading 212 credentials are unavailable.`, run.id);
    return;
  }
  if (!working) {
    const unknown = sells.find((order) => order.status === "unknown" || order.status === "intent");
    if (unknown || !reason) return;
    const remainingQuantity = Math.max(0, trade.quantity - soldQuantity);
    const brokerPosition = (await client.getPositions(trade.ticker)).find((position) => position.instrument.ticker === trade.ticker);
    const sellQuantity = Math.min(remainingQuantity, brokerPosition?.quantityAvailableForTrading ?? 0);
    if (sellQuantity <= 0) {
      await log("error", "intraday", `Cannot retry the ${trade.ticker} exit: ${remainingQuantity} app-owned shares remain but none are available at the broker. Manual action required.`, run.id);
      return;
    }
    const submission = await submitMarketOrder({
      client,
      side: "SELL",
      ticker: trade.ticker,
      quantity: sellQuantity,
      runId: run.id,
      decisionId: trade.decisionId,
      referencePrice: price ?? undefined,
      referenceAt: price == null ? undefined : quote?.quoteAt ?? undefined,
      referenceSource: "yahoo",
      quoteAgeMs: price == null ? undefined : quoteAgeMs ?? undefined,
      spreadPct: price == null ? undefined : quote?.spreadPct,
    });
    if (submission.status === "sent") {
      await setRunStatus(run.id, "exiting", reason);
    }
    return;
  }

  const done = await waitForOrder(client, Number(working.t212OrderId), 12_000);
  if (!done) return;
  if (done.status === "REJECTED" || done.status === "CANCELLED") {
    const historical = await findHistorical(client, done.id).catch(() => null);
    await db.update(orders).set({
      status: done.status === "REJECTED" ? "rejected" : "cancelled",
      filledQuantity: historical?.fill?.quantity ?? done.filledQuantity ?? 0,
      fillPrice: historical?.fill?.price ?? null,
      updatedAt: new Date(),
    }).where(eq(orders.id, working.id));
    await log("error", "intraday", `Exit order ${done.status.toLowerCase()} for ${trade.ticker}; the next tick will retry.`, run.id);
    return;
  }
  if (done.status !== "FILLED") return;

  const historical = await findHistorical(client, done.id);
  const exitPrice = historical?.fill?.price ?? price;
  const newlyFilled = historical?.fill?.quantity ?? done.filledQuantity ?? working.quantity;
  const slippagePct = price != null && exitPrice != null ? adverseSlippagePct("SELL", price, exitPrice) : null;
  await db.update(orders).set({
    status: "filled",
    filledQuantity: newlyFilled,
    fillPrice: exitPrice,
    slippagePct,
    updatedAt: new Date(),
  }).where(eq(orders.id, working.id));
  const totalFilled = soldQuantity + newlyFilled;
  const averageExitPrice = exitPrice != null && totalFilled > 0
    ? (weightedExitValue + newlyFilled * exitPrice) / totalFilled
    : null;
  if (totalFilled < trade.quantity - 1e-8) {
    await log("warn", "intraday", `Exit partially completed: ${totalFilled} of ${trade.quantity} ${trade.ticker} sold; the next tick will reconcile the remainder.`, run.id);
    return;
  }
  await closeIntradayTrade(
    run,
    trade,
    averageExitPrice,
    run.error ?? reason ?? "strategy exit",
    soldQuantity === 0 ? historical?.fill?.walletImpact?.realisedProfitLoss ?? null : null,
  );
}
