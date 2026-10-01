import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../config";
import { evaluateGuardrails, type GuardrailInput } from "./guardrails";
import { quantityFor, unitCostInAccountCcy } from "./sizing";

const base = (over: Partial<GuardrailInput> = {}): GuardrailInput => ({
  settings: SettingsSchema.parse({}),
  market: "US",
  proposal: { confidence: 0.7, investPct: 0.5, expectedMovePct: 1.5 },
  instrument: { type: "STOCK", name: "Apple Inc" },
  account: { totalValue: 1000, availableCash: 1000 },
  pnl: { dayPct: 0, weekPct: 0 },
  hasOpenPosition: false,
  minutesToClose: 12,
  ...over,
});

describe("guardrails", () => {
  it("allows a good trade and caps size by max position %", () => {
    const r = evaluateGuardrails(base());
    expect(r.allowed).toBe(true);
    expect(r.investValue).toBe(250); // 25% of 1000 total beats 50% requested
  });

  it("waives the confidence and edge minimums for a demo exploration trade, and nothing else", () => {
    const weak = { confidence: 0.3, investPct: 0.5, expectedMovePct: 0.1 };
    expect(evaluateGuardrails(base({ proposal: weak })).allowed).toBe(false);
    const explored = evaluateGuardrails(base({ proposal: weak, exploration: true }));
    expect(explored.allowed).toBe(true);
    expect(explored.notes.join(" ")).toMatch(/exploration/i);
    expect(evaluateGuardrails(base({ proposal: weak, exploration: true, settings: SettingsSchema.parse({ killSwitch: true }) })).allowed).toBe(false);
    expect(evaluateGuardrails(base({ proposal: weak, exploration: true, hasOpenPosition: true })).allowed).toBe(false);
    expect(evaluateGuardrails(base({ proposal: weak, exploration: true, instrument: { type: "CRYPTOCURRENCY", name: "Bitcoin" } })).allowed).toBe(false);
  });

  it("blocks on kill switch", () => {
    const r = evaluateGuardrails(base({ settings: SettingsSchema.parse({ killSwitch: true }) }));
    expect(r.allowed).toBe(false);
    expect(r.investValue).toBe(0);
  });

  it("blocks when a position is already open", () => {
    expect(evaluateGuardrails(base({ hasOpenPosition: true })).allowed).toBe(false);
  });

  it("allows single stocks only: ETFs, leveraged products and other types are blocked", () => {
    expect(evaluateGuardrails(base({ instrument: { type: "ETF", name: "SPDR S&P 500" } })).allowed).toBe(false);
    expect(evaluateGuardrails(base({ instrument: { type: "ETF", name: "Direxion Daily 3x Bull" } })).allowed).toBe(false);
    expect(evaluateGuardrails(base({ instrument: { type: "CRYPTOCURRENCY", name: "Bitcoin" } })).allowed).toBe(false);
  });

  it("requires higher confidence for UK and enough edge to beat stamp duty", () => {
    const uk = evaluateGuardrails(base({ market: "UK", proposal: { confidence: 0.65, investPct: 0.2, expectedMovePct: 3 } }));
    expect(uk.allowed).toBe(false);
    const thinEdge = evaluateGuardrails(base({ market: "UK", proposal: { confidence: 0.9, investPct: 0.2, expectedMovePct: 1 } }));
    expect(thinEdge.allowed).toBe(false);
    const ok = evaluateGuardrails(base({ market: "UK", proposal: { confidence: 0.9, investPct: 0.2, expectedMovePct: 3 } }));
    expect(ok.allowed).toBe(true);
  });

  it("trips loss circuit breakers", () => {
    expect(evaluateGuardrails(base({ pnl: { dayPct: -0.05, weekPct: 0 } })).allowed).toBe(false);
    expect(evaluateGuardrails(base({ pnl: { dayPct: 0, weekPct: -0.1 } })).allowed).toBe(false);
  });

  it("blocks when the market is closing or closed", () => {
    expect(evaluateGuardrails(base({ minutesToClose: 0 })).allowed).toBe(false);
  });

  it("keeps the minimum cash reserve", () => {
    const r = evaluateGuardrails(
      base({
        settings: SettingsSchema.parse({ maxPositionPct: 1, maxInvestPctOfCash: 1 }),
        proposal: { confidence: 0.7, investPct: 1, expectedMovePct: 1.5 },
      }),
    );
    expect(r.investValue).toBe(995);
  });
});

describe("sizing", () => {
  it("rounds down and never exceeds the budget", () => {
    const q = quantityFor(100, 33.33);
    expect(q).toBe(3);
    expect(q * 33.33).toBeLessThanOrEqual(100);
    expect(quantityFor(10, 33.33)).toBe(0.3);
    expect(quantityFor(0.1, 300)).toBe(0);
  });

  it("converts pence and FX", () => {
    expect(unitCostInAccountCcy(1250, "GBX", 1)).toBe(12.5);
    expect(unitCostInAccountCcy(200, "USD", 0.75)).toBe(150);
  });
});
