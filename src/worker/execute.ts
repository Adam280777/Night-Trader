import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { log } from "../lib/log";
import { getSettings } from "../lib/config";
import { tryClient } from "../lib/account";
import { fxRate, getValidatedQuotes } from "../lib/market/data";
import { quantityFor, unitCostInAccountCcy } from "../lib/risk/sizing";
import { adverseSlippagePct, findHistorical, submitMarketOrder, waitForOrder } from "../lib/t212/safeOrder";
import { checkDecisionGuardrails } from "./guard";
import { setRunStatus } from "./pipeline";
import { executionCosts } from "../lib/execution-attribution";

const { runs, decisions, trades, candidates, orders } = schema;

/** Slippage/stale-quote cushion: LSE quotes on Yahoo are ~15 min delayed. */
const BUDGET_BUFFER = { US: 0.99, UK: 0.97 } as const;

export async function executeBuy(runId: number): Promise<void> {
  const db = getDb();
  const run = await db.select().from(runs).where(eq(runs.id, runId)).get();
  const d = await db.select().from(decisions).where(eq(decisions.runId, runId)).orderBy(desc(decisions.id)).get();
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
      await db.update(decisions).set({ guardrailNotes: [...result.notes, ...result.reasons.map((r) => `BLOCKED: ${r}`)] }).where(eq(decisions.id, d.id)).run();
      await log("warn", "execute", `Blocked at execution: ${result.reasons.join(" ")}`, runId);
      setRunStatus(runId, "blocked", result.reasons.join(" "));
      return;
    }
    if (!instrument) throw new Error(`Instrument ${d.ticker} not found`);

    const cand = (await db.select().from(candidates).where(eq(candidates.runId, runId)).all()).find((c) => c.ticker === d.ticker);
    const yahoo = (cand?.signals as Record<string, string> | null)?.yahoo;
    if (!yahoo) throw new Error("Missing Yahoo symbol for candidate");
    const quote = (await getValidatedQuotes([yahoo], run.market)).get(yahoo);
    if (!quote) throw new Error(`No live quote for ${yahoo}`);
    if (quote.quoteAt == null) {
      setRunStatus(runId, "blocked", "Execution quote had no timestamp, so freshness could not be verified.");
      await log("warn", "execute", `Blocked ${d.ticker}: Yahoo quote had no market timestamp.`, runId);
      return;
    }
    const quoteAgeMs = Math.max(0, Date.now() - quote.quoteAt);
    const settings = await getSettings();
    if (
      run.market === "US" &&
      settings.marketData.requireFmpForUsOrders &&
      quote.source !== "fmp" &&
      quote.source !== "fmp+yahoo"
    ) {
      setRunStatus(runId, "blocked", "FMP real-time validation was required but unavailable.");
      await log("warn", "execute", `Blocked ${d.ticker}: FMP real-time validation was required but unavailable.`, runId, {
        quoteSource: quote.source ?? "yahoo",
        validationStatus: quote.validationStatus ?? "unknown",
      });
      return;
    }
    if (
      settings.marketData.blockOnProviderDivergence &&
      quote.divergencePct != null &&
      quote.divergencePct > settings.marketData.maxProviderDivergencePct
    ) {
      setRunStatus(runId, "blocked", `FMP and Yahoo prices disagreed by ${quote.divergencePct.toFixed(2)}%.`);
      await log("warn", "execute", `Blocked ${d.ticker}: provider price disagreement ${quote.divergencePct.toFixed(2)}%.`, runId, {
        quoteSource: quote.source,
        primaryPrice: quote.price,
        secondaryPrice: quote.secondaryPrice,
        divergencePct: quote.divergencePct,
      });
      return;
    }
    const maxAgeSeconds = run.market === "UK" ? settings.ops.maxUkQuoteAgeSeconds : settings.ops.maxUsQuoteAgeSeconds;
    if (quoteAgeMs > maxAgeSeconds * 1000) {
      setRunStatus(runId, "blocked", `Execution quote was ${Math.round(quoteAgeMs / 1000)}s old (maximum ${maxAgeSeconds}s).`);
      await log("warn", "execute", `Blocked ${d.ticker}: quote age ${Math.round(quoteAgeMs / 1000)}s exceeded ${maxAgeSeconds}s.`, runId, { quoteAt: quote.quoteAt, quoteAgeMs, maxAgeSeconds });
      return;
    }

    const fx = await fxRate(instrument.currencyCode, account.currency);
    const unit = unitCostInAccountCcy(quote.price, instrument.currencyCode, fx);
    const budget = result.investValue * BUDGET_BUFFER[run.market];
    const qty = quantityFor(budget, unit);
    if (qty <= 0) {
      setRunStatus(runId, "blocked", `Budget ${budget.toFixed(2)} ${account.currency} is below the price of one share fraction (${unit.toFixed(2)}).`);
      return;
    }
    await log("info", "execute", `${run.mode.toUpperCase()} BUY ${qty} ${d.ticker} @ ~${quote.price} ${instrument.currencyCode} (budget ${budget.toFixed(2)} ${account.currency})`, runId);

    let entryPrice = quote.price;
    let filledQty = qty;
    let entrySlippagePct: number | null = null;

    if (run.mode !== "dry") {
      const client = await tryClient();
      if (!client) throw new Error("No T212 client");
      const sub = await submitMarketOrder({
        client,
        side: "BUY",
        ticker: d.ticker,
        quantity: qty,
        runId,
        decisionId: d.id,
        referencePrice: quote.price,
        referenceAt: quote.quoteAt,
        referenceSource: quote.source === "fmp" || quote.source === "fmp+yahoo" ? "fmp" : "yahoo",
        quoteAgeMs,
        spreadPct: quote.spreadPct,
      });
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
          await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, sub.orderRowId)).run();
          setRunStatus(runId, "failed", `Buy order not filled (status ${done?.status ?? "unknown"}); cancelled.`);
          return;
        }
      } else {
        filledQty = done.filledQuantity ?? qty;
      }
      const historical = await findHistorical(client, sub.t212OrderId).catch(() => null);
      if (historical?.fill?.price) {
        entryPrice = historical.fill.price;
      } else {
        const pos = (await client.getPositions(d.ticker)).find((p) => p.instrument.ticker === d.ticker);
        if (pos) entryPrice = pos.averagePricePaid;
      }
      const slippagePct = adverseSlippagePct("BUY", quote.price, entryPrice);
      entrySlippagePct = slippagePct;
      await db.update(orders).set({ status: done?.status === "FILLED" ? "filled" : "partial", filledQuantity: filledQty, fillPrice: entryPrice, slippagePct }).where(eq(orders.id, sub.orderRowId)).run();
      const maxSlippagePct = settings.ops.maxSlippagePct;
      if (slippagePct > maxSlippagePct) {
        await log("error", "execute", `Adverse buy slippage ${slippagePct.toFixed(2)}% exceeded the ${maxSlippagePct.toFixed(2)}% alert threshold.`, runId, {
          referencePrice: quote.price,
          fillPrice: entryPrice,
          slippagePct,
          spreadPct: quote.spreadPct,
        });
      }
    }

    const intraday = run.strategy === "intraday_momentum" ? settings.intraday : null;
    const entryCosts = executionCosts(
      [{
        side: "BUY",
        quantity: filledQty,
        filledQuantity: filledQty,
        referencePrice: quote.price,
        spreadPct: quote.spreadPct,
        slippagePct: entrySlippagePct,
      }],
      instrument.currencyCode,
      fx,
      fx,
    );
    const entryNotional = filledQty * unitCostInAccountCcy(entryPrice, instrument.currencyCode, fx);
    await db.insert(trades)
      .values({
        runId,
        decisionId: d.id,
        ticker: d.ticker,
        name: d.name,
        quantity: filledQty,
        entryPrice,
        entryAt: new Date(),
        status: "open",
        strategy: run.strategy,
        stopPrice: intraday ? entryPrice * (1 - intraday.stopLossPct / 100) : null,
        targetPrice: intraday ? entryPrice * (1 + intraday.takeProfitPct / 100) : null,
        trailingStopPct: intraday?.trailingStopPct ?? null,
        highWatermark: intraday ? entryPrice : null,
        plannedExitAt: intraday ? new Date(Date.now() + intraday.maxHoldMinutes * 60_000) : null,
        instrumentCurrency: instrument.currencyCode,
        accountCurrency: account.currency,
        entryFxRate: fx,
        estimatedSpreadCost: entryCosts.estimatedSpreadCost,
        stampDutyCost: run.market === "UK" ? entryNotional * 0.005 : 0,
        slippageCost: entryCosts.slippageCost,
      })
      .run();
    setRunStatus(runId, "holding");
    await log("info", "execute", `Position open: ${filledQty} ${d.ticker} @ ${entryPrice}`, runId);
  } catch (err) {
    await log("error", "execute", `Execution failed: ${String(err)}`, runId);
    setRunStatus(runId, "failed", String(err).slice(0, 500));
  }
}
