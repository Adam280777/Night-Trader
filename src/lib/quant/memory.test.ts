import { describe, expect, it } from "vitest";
import { summariseDailyAttribution, type AttributionInput } from "./memory";

describe("trustworthy performance attribution", () => {
  it("separates execution evidence modes and never promotes dry cash P&L to broker P&L", () => {
    const base = {
      date: "2026-10-01",
      market: "UK" as const,
      strategy: "overnight" as const,
      forced: false,
      entryPrice: 100,
      exitPrice: 102,
      pnlPct: 1.2,
      pnl: 12,
    };
    const rows: AttributionInput[] = [
      { ...base, mode: "dry" },
      { ...base, mode: "live", pnlPct: 2 },
    ];

    const result = summariseDailyAttribution(rows);

    expect(result).toHaveLength(2);
    const dry = result.find((row) => row.evidenceMode === "dry")!;
    const live = result.find((row) => row.evidenceMode === "live")!;
    expect(dry.avgGrossPriceReturnPct).toBeCloseTo(2);
    expect(dry.avgEstimatedCostPct).toBeCloseTo(0.8);
    expect(dry.totalBrokerNetCashPnl).toBeNull();
    expect(dry.totalSimulatedNetCashPnl).toBe(12);
    expect(live.totalBrokerNetCashPnl).toBe(12);
    expect(live.avgEstimatedCostPct).toBeNull();
  });

  it("reports only measured components and exposes component-level coverage", () => {
    const result = summariseDailyAttribution([
      {
        date: "2026-10-01",
        market: "US",
        mode: "live",
        strategy: "intraday_momentum",
        forced: false,
        pnl: 5,
        pnlPct: 0.5,
        entryPrice: 100,
        exitPrice: 100.5,
        benchmarkReturnPct: 0.2,
        selectionReturnPct: 0.3,
        accountCurrency: "GBP",
        grossPnl: 6,
        estimatedSpreadCost: 0.4,
        stampDutyCost: 0,
        slippageCost: 0.2,
        fxImpact: -0.1,
        orders: [
          { side: "BUY", spreadPct: 0.1, slippagePct: 0.08 },
          { side: "SELL", spreadPct: 0.2, slippagePct: -0.02 },
        ],
      },
      {
        date: "2026-10-01",
        market: "US",
        mode: "live",
        strategy: "intraday_momentum",
        forced: false,
        pnl: null,
        pnlPct: null,
      },
    ])[0];

    expect(result.avgObservedSpreadPct).toBeCloseTo(0.15);
    expect(result.avgActualAdverseSlippagePct).toBeCloseTo(0.08);
    expect(result.avgMarketDirectionContributionPct).toBeCloseTo(0.2);
    expect(result.avgStockSelectionContributionPct).toBeCloseTo(0.3);
    expect(result.totalGrossPnl).toBe(6);
    expect(result.totalEstimatedSpreadCost).toBe(0.4);
    expect(result.totalSlippageCost).toBe(0.2);
    expect(result.totalFxImpact).toBe(-0.1);
    expect(result.accountCurrency).toBe("GBP");
    expect(result.avgSpreadCostPct).toBeNull();
    expect(result.avgUkStampDutyPct).toBeNull();
    expect(result.coverage.grossPriceReturn).toBe(1);
    expect(result.coverage.brokerNetCashPnl).toBe(1);
    expect(result.coverage.spreadCost).toBe(0);
  });

  it("keeps exploration evidence distinct from ordinary model selection", () => {
    const common = {
      date: "2026-10-01",
      market: "US" as const,
      mode: "demo" as const,
      strategy: "overnight" as const,
      pnl: null,
      pnlPct: null,
    };
    const result = summariseDailyAttribution([
      { ...common, forced: false },
      { ...common, forced: true },
    ]);
    expect(result.map((row) => row.selectionEvidence).sort()).toEqual(["exploration_override", "model_selected"]);
  });
});
