import { describe, expect, it } from "vitest";
import { executionCosts, priceAndFxAttribution } from "./execution-attribution";

describe("execution attribution", () => {
  it("separates price return from currency movement", () => {
    const result = priceAndFxAttribution({
      quantity: 10,
      entryPrice: 100,
      exitPrice: 110,
      instrumentCurrency: "USD",
      entryFxRate: 0.75,
      exitFxRate: 0.8,
    });
    expect(result.grossPnl).toBe(75);
    expect(result.fxImpact).toBeCloseTo(55);
  });

  it("normalises GBX and separates spread from adverse slippage", () => {
    const result = executionCosts(
      [{
        side: "BUY",
        quantity: 100,
        filledQuantity: 100,
        referencePrice: 250,
        spreadPct: 0.4,
        slippagePct: 0.2,
      }],
      "GBX",
      1,
      1,
    );
    expect(result.estimatedSpreadCost).toBeCloseTo(0.5);
    expect(result.slippageCost).toBeCloseTo(0.5);
  });
});
