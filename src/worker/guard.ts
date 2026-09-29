import { eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { evaluateGuardrails, type GuardrailResult } from "../lib/risk/guardrails";
import { getAccountState, openTrade, pnlWindows, tryClient } from "../lib/account";
import { getInstrumentsCached, marketOf } from "../lib/t212/instruments";
import type { AccountState } from "../lib/account";
import { anyUnknownOrders } from "../lib/t212/safeOrder";

/** Guardrail check for a stored decision using fresh account data. Used at decision time and again right before buying. */
export async function checkDecisionGuardrails(
  decisionId: number,
  minutesToClose: number,
  account?: AccountState,
): Promise<{ result: GuardrailResult; account: AccountState; instrument: { type: string; name: string; currencyCode: string } | null }> {
  const db = getDb();
  const d = await db.select().from(schema.decisions).where(eq(schema.decisions.id, decisionId)).get();
  if (!d || d.action !== "BUY" || !d.ticker) throw new Error(`Decision ${decisionId} is not a BUY`);
  const run = (await db.select().from(schema.runs).where(eq(schema.runs.id, d.runId)).get())!;

  const client = await tryClient();
  const acct = account ?? (await getAccountState(client));
  const inst = client ? (await getInstrumentsCached(client)).find((i) => i.ticker === d.ticker) : undefined;
  const market = inst ? marketOf(inst) ?? run.market : run.market;

  const result = evaluateGuardrails({
    settings: await getSettings(),
    market,
    ai: { confidence: d.confidence ?? 0, investPct: d.investPct ?? 0, expectedMovePct: d.expectedMovePct ?? 0 },
    instrument: { type: inst?.type ?? "STOCK", name: inst?.name ?? d.name ?? "" },
    account: { totalValue: acct.totalValue, availableCash: acct.availableCash },
    pnl: await pnlWindows(acct.totalValue),
    hasOpenPosition: !!await openTrade(),
    minutesToClose,
  });
  if (await anyUnknownOrders()) {
    result.allowed = false;
    result.investValue = 0;
    result.reasons.push("An earlier order has an unknown outcome; resolve it manually before trading.");
  }
  return { result, account: acct, instrument: inst ? { type: inst.type, name: inst.name, currencyCode: inst.currencyCode } : null };
}
