import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { OrderOutcomeUnknownError, T212Error, type T212Client } from "./client";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
});

afterAll(() => {
  vi.useRealTimers();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the SQLite file */
  }
});

async function setup() {
  const { getDb, schema } = await import("../db");
  const { submitMarketOrder } = await import("./safeOrder");
  const db = getDb();
  const run = db.insert(schema.runs).values({ tradingDate: "2026-01-02", market: "US", mode: "demo", status: "executing" }).returning({ id: schema.runs.id }).get();
  return { db, schema, submitMarketOrder, runId: run.id };
}

function fakeClient(over: Partial<Record<keyof T212Client, unknown>>): { client: T212Client; place: ReturnType<typeof vi.fn> } {
  const place = (over.placeMarketOrder as ReturnType<typeof vi.fn>) ?? vi.fn();
  const client = {
    placeMarketOrder: place,
    getPendingOrders: over.getPendingOrders ?? (async () => []),
    getHistoricalOrders: over.getHistoricalOrders ?? (async () => []),
  } as unknown as T212Client;
  return { client, place };
}

describe("submitMarketOrder", () => {
  it("records the intent, sends once, and marks the order sent", async () => {
    const { db, schema, submitMarketOrder, runId } = await setup();
    const { client, place } = fakeClient({ placeMarketOrder: vi.fn(async () => ({ id: 111, status: "NEW" })) });
    const r = await submitMarketOrder({ client, side: "BUY", ticker: "AAPL_US_EQ", quantity: 2, runId, decisionId: null });
    expect(r.status).toBe("sent");
    expect(place).toHaveBeenCalledTimes(1);
    expect(place).toHaveBeenCalledWith("AAPL_US_EQ", 2, false);
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, r.orderRowId)).get()?.t212OrderId).toBe("111");
  });

  it("sends a negative quantity for SELL", async () => {
    const { submitMarketOrder, runId } = await setup();
    const { client, place } = fakeClient({ placeMarketOrder: vi.fn(async () => ({ id: 112, status: "NEW" })) });
    await submitMarketOrder({ client, side: "SELL", ticker: "AAPL_US_EQ", quantity: 2, runId, decisionId: null });
    expect(place).toHaveBeenCalledWith("AAPL_US_EQ", -2, false);
  });

  it("on timeout never re-sends; adopts the order if it exists on the account", async () => {
    vi.useFakeTimers();
    const { db, schema, submitMarketOrder, runId } = await setup();
    const place = vi.fn(async () => {
      throw new OrderOutcomeUnknownError("timeout");
    });
    const { client } = fakeClient({
      placeMarketOrder: place,
      getPendingOrders: async () => [{ id: 222, ticker: "MSFT_US_EQ", side: "BUY", createdAt: new Date(Date.now() + 1000).toISOString(), status: "NEW" }],
    });
    const p = submitMarketOrder({ client, side: "BUY", ticker: "MSFT_US_EQ", quantity: 1, runId, decisionId: null });
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(place).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("sent");
    expect(r.t212OrderId).toBe(222);
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, r.orderRowId)).get()?.status).toBe("sent");
  });

  it("on timeout with nothing found, marks the order unknown, blocks trading, and still does not re-send", async () => {
    vi.useFakeTimers();
    const { db, schema, submitMarketOrder, runId } = await setup();
    const { anyUnknownOrders } = await import("./safeOrder");
    const place = vi.fn(async () => {
      throw new OrderOutcomeUnknownError("timeout");
    });
    const { client } = fakeClient({ placeMarketOrder: place });
    const p = submitMarketOrder({ client, side: "BUY", ticker: "NVDA_US_EQ", quantity: 1, runId, decisionId: null });
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(place).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("unknown");
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, r.orderRowId)).get()?.status).toBe("unknown");
    expect(anyUnknownOrders()).toBe(true);
  });

  it("a definite API rejection is recorded as rejected", async () => {
    const { db, schema, submitMarketOrder, runId } = await setup();
    const { client } = fakeClient({
      placeMarketOrder: vi.fn(async () => {
        throw new T212Error("Bad request", 400, { code: "InsufficientFreeForStocksBuy" });
      }),
    });
    const r = await submitMarketOrder({ client, side: "BUY", ticker: "TSLA_US_EQ", quantity: 1, runId, decisionId: null });
    expect(r.status).toBe("rejected");
    expect(db.select().from(schema.orders).where(eq(schema.orders.id, r.orderRowId)).get()?.status).toBe("rejected");
  });
});
