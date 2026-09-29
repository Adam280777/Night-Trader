import { config } from "dotenv";
import { and, eq, inArray } from "drizzle-orm";

config({ path: ".env.local" });
config();

import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { log } from "../lib/log";
import { tryClient } from "../lib/account";
import { tick } from "./scheduler";
import { setRunStatus } from "./pipeline";

const { runs, orders, trades, decisions, candidates } = schema;

/** Repair whatever a crash or restart left half-done. Runs once at startup, before the first tick. */
async function reconcileOnStartup() {
  const db = getDb();

  // An order intent with no T212 id might or might not have reached the broker: never guess, never resend.
  const stale = db.select().from(orders).where(and(eq(orders.status, "intent"))).all();
  for (const o of stale) {
    db.update(orders).set({ status: "unknown", error: "Worker restarted before the order call returned", updatedAt: new Date() }).where(eq(orders.id, o.id)).run();
    log("error", "startup", `Order #${o.id} (${o.side} ${o.ticker}) has an unknown outcome. Check Trading 212, then resolve it in the app.`, o.runId ?? undefined);
  }

  // Interrupted before any order existed: restart the run if there is still time, otherwise fail it.
  const interrupted = db.select().from(runs).where(inArray(runs.status, ["screening", "researching", "deciding"])).all();
  for (const r of interrupted) {
    const minsLeft = ((r.sessionCloseAt?.getTime() ?? 0) - Date.now()) / 60_000;
    if (minsLeft > 25) {
      db.delete(decisions).where(eq(decisions.runId, r.id)).run();
      db.delete(candidates).where(eq(candidates.runId, r.id)).run();
      setRunStatus(r.id, "scheduled");
      log("info", "startup", `Run #${r.id} was interrupted; restarting it (${Math.round(minsLeft)} min to close).`, r.id);
    } else {
      setRunStatus(r.id, "failed", "Interrupted by a restart too close to the close");
    }
  }

  // Crashed mid-buy: trust the broker's position list.
  const executing = db.select().from(runs).where(eq(runs.status, "executing")).all();
  const client = tryClient();
  for (const r of executing) {
    const d = db.select().from(decisions).where(eq(decisions.runId, r.id)).get();
    const hasTrade = db.select().from(trades).where(eq(trades.runId, r.id)).get();
    if (hasTrade) {
      setRunStatus(r.id, "holding");
      continue;
    }
    if (r.mode !== "dry" && client && d?.ticker) {
      const pos = (await client.getPositions(d.ticker)).find((p) => p.instrument.ticker === d.ticker);
      if (pos && pos.quantity > 0) {
        db.insert(trades)
          .values({ runId: r.id, decisionId: d.id, ticker: d.ticker, name: d.name, quantity: pos.quantity, entryPrice: pos.averagePricePaid, entryAt: new Date(), status: "open" })
          .run();
        setRunStatus(r.id, "holding");
        log("warn", "startup", `Recovered open position ${pos.quantity} ${d.ticker} for run #${r.id}.`, r.id);
        continue;
      }
    }
    setRunStatus(r.id, "failed", "Interrupted during buy; no position found");
  }
}

async function main() {
  const s = getSettings();
  log("info", "worker", `Worker starting. Trading ${s.tradingEnabled ? "ENABLED" : "disabled (dry-run)"}, approval ${s.approvalMode ? "on" : "off"}, kill switch ${s.killSwitch ? "ON" : "off"}.`);
  await reconcileOnStartup();
  await tick();
  setInterval(() => void tick().catch((e) => log("error", "worker", `tick failed: ${String(e)}`)), 20_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
