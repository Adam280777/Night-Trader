import { eq } from "drizzle-orm";
import { getDb, schema } from "../lib/db";
import { getSettings } from "../lib/config";
import { evaluateGuardrails, type GuardrailResult } from "../lib/risk/guardrails";
import { getAccountState, openTrade, pnlWindows, tryClient } from "../lib/account";
import { getInstrumentsCached, marketOf } from "../lib/t212/instruments";
import type { AccountState } from "../lib/account";
import { anyUnknownOrders } from "../lib/t212/safeOrder";
import { getHighImpactEconomicEvents } from "../lib/market/fmp";

/** Guardrail check for a stored decision using fresh account data. Used at decision time and again right before buying. */
export async function checkDecisionGuardrails(
  decisionId: number,
  minutesToClose: number,
  account?: AccountState,
  options: { ignoreOpenPosition?: boolean } = {},
): Promise<{ result: GuardrailResult; account: AccountState; instrument: { type: string; name: string; currencyCode: string } | null }> {
  const db = getDb();
  const d = await db.select().from(schema.decisions).where(eq(schema.decisions.id, decisionId)).get();
  if (!d || d.action !== "BUY" || !d.ticker) throw new Error(`Decision ${decisionId} is not a BUY`);
  const run = (await db.select().from(schema.runs).where(eq(schema.runs.id, d.runId)).get())!;

  const client = await tryClient();
  const acct = account ?? (await getAccountState(client));
  const inst = client ? (await getInstrumentsCached(client)).find((i) => i.ticker === d.ticker) : undefined;
  const market = inst ? marketOf(inst) ?? run.market : run.market;

  const settings = await getSettings();
  const result = evaluateGuardrails({
    settings,
    market,
    proposal: { confidence: d.confidence ?? 0, investPct: d.investPct ?? 0, expectedMovePct: d.expectedMovePct ?? 0 },
    instrument: { type: inst?.type ?? "STOCK", name: inst?.name ?? d.name ?? "" },
    account: { totalValue: acct.totalValue, availableCash: acct.availableCash },
    pnl: await pnlWindows(acct.totalValue),
    hasOpenPosition: options.ignoreOpenPosition ? false : !!await openTrade(),
    minutesToClose,
    exploration: d.forced && run.mode === "demo",
    minimums: run.strategy === "intraday_momentum"
      ? { confidence: settings.intraday.minConfidence, expectedEdgePct: settings.intraday.minExpectedEdgePct }
      : undefined,
  });
  if (await anyUnknownOrders()) {
    result.allowed = false;
    result.investValue = 0;
    result.reasons.push("An earlier order has an unknown outcome; resolve it manually before trading.");
  }
  if (settings.marketData.fmpEnabled && settings.marketData.blockHighImpactEconomicEvents) {
    const now = new Date();
    const horizonHours =
      run.strategy === "intraday_momentum"
        ? Math.max(1, settings.marketData.intradayEconomicEventBufferMinutes / 60)
        : settings.marketData.overnightEconomicEventLookaheadHours;
    try {
      const events = await getHighImpactEconomicEvents(now, horizonHours);
      const relevant = events.find((event) => {
        const deltaMinutes = (event.at.getTime() - now.getTime()) / 60_000;
        return run.strategy === "intraday_momentum"
          ? Math.abs(deltaMinutes) <= settings.marketData.intradayEconomicEventBufferMinutes
          : deltaMinutes >= 0 && deltaMinutes <= settings.marketData.overnightEconomicEventLookaheadHours * 60;
      });
      if (relevant) {
        result.allowed = false;
        result.investValue = 0;
        result.reasons.push(`High-impact US economic event inside the safety window: ${relevant.event} at ${relevant.at.toISOString()}.`);
      }
    } catch (error) {
      if (settings.marketData.requireFmpForUsOrders && run.market === "US") {
        result.allowed = false;
        result.investValue = 0;
        result.reasons.push(`FMP event-risk check failed while FMP is required: ${String(error).slice(0, 140)}`);
      } else {
        result.notes.push(`FMP event-risk calendar unavailable: ${String(error).slice(0, 140)}`);
      }
    }
  }
  return { result, account: acct, instrument: inst ? { type: inst.type, name: inst.name, currencyCode: inst.currencyCode } : null };
}
