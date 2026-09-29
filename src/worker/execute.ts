import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { tryClient } from "../lib/account";
import { fxRate, getQuotes } from "../lib/market/data";
import { quantityFor, unitCostInAccountCcy } from "../lib/risk/sizing";
import { submitMarketOrder, waitForOrder } from "../lib/t212/safeOrder";
import { checkDecisionGuardrails } from "./guard";
import { setRunStatus } from "./pipeline";

const { runs, decisions, trades, candidates, orders } = schema;

/** Slippage/stale-quote cushion: LSE quotes on Yahoo are ~15 min delayed. */
const BUDGET_BUFFER = { US: 0.99, UK: 0.97 } as const;

export async function executeBuy(runId: number): Promise<void> {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  const d = db.select().from(decisions).where(eq(decisions.runId, runId)).orderBy(desc(decisions.id)).get();
  if (!run || !d || d.action !== "BUY" || !d.ticker) return;

  const minutesToClose = ((run.sessionCloseAt?.getTime() ?? 0) - Date.now()) / 60_000;
  try {
    setRunStatus(runId, "executing");
    if (minutesToClose < 1.5) {
      setRunStatus(runId, "no_trade", "Missed the buy window.");
      return;
    }

    const { result, account, instrument } = await checkDecisionGuardrails(d.id, minutesToClose);
    if (!result.allowed) {
      db.update(decisions).set({ guardrailNotes: [...result.notes, ...result.reasons.map((r) => `BLOCKED: ${r}`)] }).where(eq(decisions.id, d.id)).run();
      log("warn", "execute", `Blocked at execution: ${result.reasons.join(" ")}`, runId);
      setRunStatus(runId, "blocked", result.reasons.join(" "));
      return;
    }
    if (!instrument) throw new Error(`Instrument ${d.ticker} not found`);

    const cand = db.select().from(candidates).where(eq(candidates.runId, runId)).all().find((c) => c.ticker === d.ticker);
    const yahoo = (cand?.signals as Record<string, string> | null)?.yahoo;
    if (!yahoo) throw new Error("Missing Yahoo symbol for candidate");
    const quote = (await getQuotes([yahoo])).get(yahoo);
    if (!quote) throw new Error(`No live quote for ${yahoo}`);

    const fx = await fxRate(instrument.currencyCode, account.currency);
    const unit = unitCostInAccountCcy(quote.price, instrument.currencyCode, fx);
    const budget = result.investValue * BUDGET_BUFFER[run.market];
    const qty = quantityFor(budget, unit);
    if (qty <= 0) {
      setRunStatus(runId, "blocked", `Budget ${budget.toFixed(2)} ${account.currency} is below the price of one share fraction (${unit.toFixed(2)}).`);
      return;
    }
    log("info", "execute", `${run.mode.toUpperCase()} BUY ${qty} ${d.ticker} @ ~${quote.price} ${instrument.currencyCode} (budget ${budget.toFixed(2)} ${account.currency})`, runId);

    let entryPrice = quote.price;
    let filledQty = qty;

    if (run.mode !== "dry") {
      const client = tryClient();
      if (!client) throw new Error("No T212 client");
      const sub = await submitMarketOrder({ client, side: "BUY", ticker: d.ticker, quantity: qty, runId, decisionId: d.id });
      if (sub.status !== "sent" || !sub.t212OrderId) {
        setRunStatus(runId, sub.status === "unknown" ? "failed" : "blocked", `Buy order ${sub.status}`);
        return;
      }
      const waitMs = Math.max(20_000, Math.min(150_000, (run.sessionCloseAt!.getTime() - Date.now()) - 60_000));
      const done = await waitForOrder(client, sub.t212OrderId, waitMs);
      if (!done || done.status !== "FILLED") {
        // Never leave a working remainder behind after the deadline.
        try {
          await client.cancelOrder(sub.t212OrderId);
        } catch {
          /* already terminal */
        }
        filledQty = done?.filledQuantity ?? 0;
        if (filledQty <= 0) {
          db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, sub.orderRowId)).run();
          setRunStatus(runId, "failed", `Buy order not filled (status ${done?.status ?? "unknown"}); cancelled.`);
          return;
        }
      } else {
        filledQty = done.filledQuantity ?? qty;
      }
      db.update(orders).set({ status: "filled", filledQuantity: filledQty }).where(eq(orders.id, sub.orderRowId)).run();
      const pos = (await client.getPositions(d.ticker)).find((p) => p.instrument.ticker === d.ticker);
      if (pos) entryPrice = pos.averagePricePaid;
    }

    db.insert(trades)
      .values({ runId, decisionId: d.id, ticker: d.ticker, name: d.name, quantity: filledQty, entryPrice, entryAt: new Date(), status: "open" })
      .run();
    setRunStatus(runId, "holding");
    log("info", "execute", `Position open: ${filledQty} ${d.ticker} @ ${entryPrice}`, runId);
  } catch (err) {
    log("error", "execute", `Execution failed: ${String(err)}`, runId);
    setRunStatus(runId, "failed", String(err).slice(0, 500));
  }
}
