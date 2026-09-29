import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { log } from "../lib/log";
import { tryClient } from "../lib/account";
import { estimatedRoundTripCostPct } from "../lib/risk/guardrails";
import { fxRate, getDailyBars } from "../lib/market/data";
import { tradingDateOf } from "../lib/market/sessions";
import { unitCostInAccountCcy } from "../lib/risk/sizing";
import { findHistorical, submitMarketOrder, waitForOrder } from "../lib/t212/safeOrder";
import { getInstrumentsCached } from "../lib/t212/instruments";
import { setRunStatus } from "./pipeline";
import { finalizeTrade } from "./finalize";

const { runs, trades, orders, candidates } = schema;
const MAX_SELL_ATTEMPTS = 3;

/**
 * Called repeatedly by the scheduler once it is time to exit (shortly before the next open for
 * real orders, after the open for dry runs). Safe to call again after a restart.
 */
export async function executeExit(runId: number): Promise<void> {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  const trade = db.select().from(trades).where(and(eq(trades.runId, runId), eq(trades.status, "open"))).get();
  if (!run || !trade) return;

  try {
    if (run.mode === "dry") return await exitDry(run, trade);
    await exitReal(run, trade);
  } catch (err) {
    log("error", "exit", `Exit step failed: ${String(err)}`, runId);
  }
}

type Run = typeof runs.$inferSelect;
type Trade = typeof trades.$inferSelect;

async function accountFx(ticker: string) {
  const client = tryClient();
  if (!client) return { fx: 1, ccy: "GBP", instCcy: "GBP" };
  const [summary, inst] = await Promise.all([client.getAccountSummary(), getInstrumentsCached(client)]);
  const instCcy = inst.find((i) => i.ticker === ticker)?.currencyCode ?? summary.currency;
  return { fx: await fxRate(instCcy, summary.currency), ccy: summary.currency, instCcy };
}

async function exitDry(run: Run, trade: Trade) {
  const db = getDb();
  const cand = db.select().from(candidates).where(eq(candidates.runId, run.id)).all().find((c) => c.ticker === trade.ticker);
  const yahoo = (cand?.signals as Record<string, string> | null)?.yahoo;
  if (!yahoo) throw new Error("Missing Yahoo symbol");

  const bars = await getDailyBars(yahoo, 15);
  const next = bars.find((b) => tradingDateOf(run.market, b.date) > run.tradingDate);
  if (!next) return; // next session's open not available yet

  const entry = trade.entryPrice ?? next.open;
  const gross = (next.open / entry - 1) * 100;
  const net = gross - estimatedRoundTripCostPct(run.market);
  const { fx, instCcy } = await accountFx(trade.ticker);
  const invested = trade.quantity * unitCostInAccountCcy(entry, instCcy, fx);

  await closeTrade(run, trade, { exitPrice: next.open, pnlPct: net, pnl: (invested * net) / 100 });
}

async function exitReal(run: Run, trade: Trade) {
  const db = getDb();
  const client = tryClient();
  if (!client) throw new Error("No T212 client");

  const sells = db.select().from(orders).where(and(eq(orders.runId, run.id), eq(orders.side, "SELL"))).orderBy(desc(orders.id)).all();
  const last = sells[0];

  // Place (or re-place) the sell if none is working.
  const working = last && (last.status === "sent" || last.status === "intent") && last.t212OrderId;
  if (!working) {
    if (sells.filter((s) => s.status === "rejected" || s.status === "cancelled").length >= MAX_SELL_ATTEMPTS) {
      log("error", "exit", `Sell failed ${MAX_SELL_ATTEMPTS} times for ${trade.ticker}. MANUAL ACTION NEEDED.`, run.id);
      return;
    }
    // "unknown", or an "intent" that never got an id (crash mid-call): a duplicate sell is worse than waiting for a human.
    if (last?.status === "unknown" || last?.status === "intent") return;
    const pos = (await client.getPositions(trade.ticker)).find((p) => p.instrument.ticker === trade.ticker);
    if (!pos || pos.quantityAvailableForTrading <= 0) {
      log("warn", "exit", `No ${trade.ticker} position found (sold manually?). Closing trade without P&L.`, run.id);
      db.update(trades).set({ status: "closed", exitAt: new Date() }).where(eq(trades.id, trade.id)).run();
      setRunStatus(run.id, "closed", "Position not found at exit");
      return;
    }
    const sub = await submitMarketOrder({ client, side: "SELL", ticker: trade.ticker, quantity: pos.quantityAvailableForTrading, runId: run.id, decisionId: trade.decisionId });
    if (sub.status !== "sent") return;
    setRunStatus(run.id, "exiting");
    return;
  }

  const done = await waitForOrder(client, Number(last.t212OrderId), 20_000);
  if (!done) return;
  if (done.status === "REJECTED" || done.status === "CANCELLED") {
    db.update(orders).set({ status: done.status === "REJECTED" ? "rejected" : "cancelled", updatedAt: new Date() }).where(eq(orders.id, last.id)).run();
    log("warn", "exit", `Sell order ${done.status}; will retry.`, run.id);
    return;
  }
  if (done.status !== "FILLED") return; // still queued for the open

  db.update(orders).set({ status: "filled", filledQuantity: done.filledQuantity ?? null, updatedAt: new Date() }).where(eq(orders.id, last.id)).run();
  const hist = await findHistorical(client, done.id);
  const exitPrice = hist?.fill?.price ?? null;
  const entry = trade.entryPrice;
  const pnlPct = exitPrice && entry ? (exitPrice / entry - 1) * 100 : null;
  const pnl = hist?.fill?.walletImpact?.realisedProfitLoss ?? null;
  await closeTrade(run, trade, { exitPrice, pnlPct, pnl });
}

async function closeTrade(run: Run, trade: Trade, r: { exitPrice: number | null; pnlPct: number | null; pnl: number | null }) {
  const db = getDb();
  db.update(trades).set({ status: "closed", exitAt: new Date(), exitPrice: r.exitPrice, pnlPct: r.pnlPct, pnl: r.pnl }).where(eq(trades.id, trade.id)).run();
  setRunStatus(run.id, "closed");
  log("info", "exit", `Closed ${trade.ticker}: ${r.pnlPct == null ? "n/a" : r.pnlPct.toFixed(2) + "%"} (${r.pnl?.toFixed(2) ?? "n/a"})`, run.id);
  void finalizeTrade(trade.id);
}
