import type { Settings } from "../config";
import type { Market } from "../t212/instruments";
import { roundTripCostPct } from "../quant/costs";
import type { QuantTuning } from "../quant/tuning";

export interface GuardrailInput {
  settings: Settings;
  market: Market;
  proposal: { confidence: number; investPct: number; expectedMovePct: number };
  instrument: { type: string; name: string };
  account: { totalValue: number; availableCash: number };
  /** Realised+unrealised change as a fraction of starting value, negative = loss. */
  pnl: { dayPct: number; weekPct: number };
  hasOpenPosition: boolean;
  minutesToClose: number;
  /**
   * A demo exploration trade deliberately ignores the confidence and net-edge minimums (that is the
   * point of it). Every safety check - kill switch, loss limits, sizing, instrument type - still applies.
   */
  exploration?: boolean;
  /** Strategy-specific evidence thresholds. Account-wide safety caps still come from Settings. */
  minimums?: { confidence: number; expectedEdgePct: number };
}

export interface GuardrailResult {
  allowed: boolean;
  /** Cash value (account currency) we are permitted to invest. 0 if blocked. */
  investValue: number;
  reasons: string[]; // why blocked
  notes: string[]; // adjustments/info
}

/** Approximate round-trip cost as a % of position (FX, stamp duty, spread), from the tuned cost settings. */
export function estimatedRoundTripCostPct(market: Market, tuning?: QuantTuning): number {
  return roundTripCostPct(market, undefined, tuning);
}

const LEVERAGED = /\b(2x|3x|5x|-1x|-2x|-3x|leveraged|ultra|ultrashort|inverse|bull|bear|short)\b/i;

export function evaluateGuardrails(i: GuardrailInput): GuardrailResult {
  const s = i.settings;
  const reasons: string[] = [];
  const notes: string[] = [];

  if (s.killSwitch) reasons.push("Kill switch is on.");
  if (i.hasOpenPosition) reasons.push("A position is already open; one stock at a time.");
  if (i.instrument.type !== "STOCK") reasons.push(`Instrument type ${i.instrument.type} not allowed; single stocks only.`);
  if (LEVERAGED.test(i.instrument.name)) reasons.push("Leveraged/inverse products are not allowed.");

  const minConf = i.minimums?.confidence ?? (i.market === "UK" ? Math.max(s.minConfidence, s.ukMinConfidence) : s.minConfidence);
  if (i.exploration) {
    notes.push("Demo exploration trade: confidence and edge minimums waived so the outcome can be learned from.");
  } else if (i.proposal.confidence < minConf) {
    reasons.push(`Confidence ${(i.proposal.confidence * 100).toFixed(0)}% below required ${(minConf * 100).toFixed(0)}%.`);
  }

  const cost = estimatedRoundTripCostPct(i.market, s.quant);
  const netEdge = i.proposal.expectedMovePct - cost;
  const minEdge = i.minimums?.expectedEdgePct ?? s.minExpectedEdgePct;
  if (!i.exploration && netEdge < minEdge) {
    reasons.push(
      `Expected move ${i.proposal.expectedMovePct.toFixed(2)}% minus ~${cost.toFixed(2)}% costs leaves ${netEdge.toFixed(2)}%, below the ${minEdge}% minimum.`,
    );
  }

  if (i.pnl.dayPct <= -s.dailyLossLimitPct) reasons.push("Daily loss limit reached.");
  if (i.pnl.weekPct <= -s.weeklyLossLimitPct) reasons.push("Weekly loss limit reached.");

  if (i.minutesToClose < 1) reasons.push("Market is closed or about to close.");

  const requested = Math.max(0, i.proposal.investPct) * i.account.availableCash;
  const caps = {
    cashCap: s.maxInvestPctOfCash * i.account.availableCash,
    positionCap: s.maxPositionPct * i.account.totalValue,
    reserveCap: i.account.availableCash - s.minCashReserve,
  };
  const investValue = Math.max(0, Math.min(requested, caps.cashCap, caps.positionCap, caps.reserveCap));
  if (investValue < requested) notes.push(`Size reduced from ${requested.toFixed(2)} to ${investValue.toFixed(2)} by limits.`);
  if (investValue <= 0) reasons.push("No investable cash after limits.");

  const allowed = reasons.length === 0;
  return { allowed, investValue: allowed ? investValue : 0, reasons, notes };
}
