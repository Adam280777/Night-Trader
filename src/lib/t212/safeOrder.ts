import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { log } from "../log";
import { OrderOutcomeUnknownError, T212Error, type HistoricalOrder, type T212Client, type T212Order } from "./client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SubmitArgs {
  client: T212Client;
  side: "BUY" | "SELL";
  ticker: string;
  /** Always positive; the sign is applied here. */
  quantity: number;
  runId: number;
  decisionId: number | null;
  referencePrice?: number;
  referenceAt?: number;
  referenceSource?: "yahoo" | "fmp" | "broker_preopen";
  quoteAgeMs?: number;
  spreadPct?: number | null;
}

export function adverseSlippagePct(side: "BUY" | "SELL", referencePrice: number, fillPrice: number): number {
  if (!(referencePrice > 0) || !(fillPrice > 0)) return 0;
  return (side === "BUY" ? fillPrice / referencePrice - 1 : referencePrice / fillPrice - 1) * 100;
}

/**
 * T212's market-order endpoint is not idempotent, so:
 *  1. the intent is persisted BEFORE the call,
 *  2. a timeout/network error is never retried; we look for the order on the account instead,
 *  3. anything we can't resolve stays "unknown" and blocks further trading until a human looks.
 */
export async function submitMarketOrder(a: SubmitArgs): Promise<{ orderRowId: number; status: "sent" | "rejected" | "unknown"; t212OrderId?: number }> {
  const db = getDb();
  const intentAt = Date.now();
  const [row] = await db
    .insert(schema.orders)
    .values({
      decisionId: a.decisionId,
      runId: a.runId,
      side: a.side,
      ticker: a.ticker,
      quantity: a.quantity,
      status: "intent",
      referencePrice: a.referencePrice,
      referenceAt: a.referenceAt == null ? undefined : new Date(a.referenceAt),
      referenceSource: a.referenceSource,
      quoteAgeMs: a.quoteAgeMs,
      spreadPct: a.spreadPct,
    })
    .returning({ id: schema.orders.id });

  const signed = a.side === "BUY" ? a.quantity : -a.quantity;
  const update = (v: Partial<typeof schema.orders.$inferInsert>) =>
    db.update(schema.orders).set({ ...v, updatedAt: new Date() }).where(eq(schema.orders.id, row.id));

  try {
    const o = await a.client.placeMarketOrder(a.ticker, signed, false);
    await update({ status: "sent", t212OrderId: String(o.id), raw: o });
    await log("info", "order", `${a.side} ${a.quantity} ${a.ticker} accepted (T212 id ${o.id}, status ${o.status})`, a.runId);
    return { orderRowId: row.id, status: "sent", t212OrderId: o.id };
  } catch (err) {
    if (err instanceof OrderOutcomeUnknownError) {
      await log("warn", "order", `${err.message}. Reconciling instead of retrying.`, a.runId);
      const found = await findOrderSince(a.client, a.ticker, a.side, intentAt - 5_000);
      if (found) {
        await update({ status: "sent", t212OrderId: String(found.id), raw: found });
        await log("info", "order", `Reconciled: order ${found.id} exists (${found.status}).`, a.runId);
        return { orderRowId: row.id, status: "sent", t212OrderId: found.id };
      }
      await update({ status: "unknown", error: err.message });
      await log("error", "order", `Order outcome UNKNOWN for ${a.side} ${a.ticker}; trading paused for manual check.`, a.runId);
      return { orderRowId: row.id, status: "unknown" };
    }
    const msg = err instanceof T212Error ? `${err.message} ${JSON.stringify(err.body ?? {})}` : String(err);
    await update({ status: "rejected", error: msg });
    await log("error", "order", `Order rejected: ${msg}`, a.runId);
    return { orderRowId: row.id, status: "rejected" };
  }
}

/** Look in pending orders, then recent history, for an order we may have created but never got a reply for. */
async function findOrderSince(client: T212Client, ticker: string, side: "BUY" | "SELL", sinceMs: number): Promise<T212Order | null> {
  for (let i = 0; i < 3; i++) {
    await sleep(6_000);
    try {
      const pending = await client.getPendingOrders();
      const p = pending.find((o) => o.ticker === ticker && o.side === side && Date.parse(o.createdAt) >= sinceMs);
      if (p) return p;
      const hist = await client.getHistoricalOrders(1);
      const h = hist.find((x) => x.order.ticker === ticker && x.order.side === side && Date.parse(x.order.createdAt) >= sinceMs);
      if (h) return h.order;
    } catch {
      /* rate limited: try again */
    }
  }
  return null;
}

const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "REPLACED"]);

/** Poll until the order reaches a terminal state or `timeoutMs` passes. */
export async function waitForOrder(client: T212Client, orderId: number, timeoutMs: number): Promise<T212Order | null> {
  const end = Date.now() + timeoutMs;
  let last: T212Order | null = null;
  while (Date.now() < end) {
    try {
      last = await client.getOrder(orderId);
      if (TERMINAL.has(last.status)) return last;
    } catch (err) {
      // Filled orders can leave the pending endpoint; history is authoritative.
      if (err instanceof T212Error && err.status === 404) {
        const h = await findHistorical(client, orderId);
        if (h) return h.order;
      }
    }
    await sleep(3_000);
  }
  return last;
}

export async function findHistorical(client: T212Client, orderId: number): Promise<HistoricalOrder | null> {
  const hist = await client.getHistoricalOrders(1);
  return hist.find((h) => h.order.id === orderId) ?? null;
}

export async function anyUnknownOrders(): Promise<boolean> {
  const rows = await getDb().select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.status, "unknown")).limit(1);
  return rows.length > 0;
}
