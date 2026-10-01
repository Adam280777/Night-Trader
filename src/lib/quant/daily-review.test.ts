import { describe, expect, it } from "vitest";
import { buildDailyOperationalReview, type DailyReviewSnapshot } from "./daily-review";

const snapshot = (): DailyReviewSnapshot => ({
  date: "2026-10-01",
  totals: { consideredCandidates: 1, trades: 1, abstentions: 1, executionOrders: 2, slippageMeasured: 1 },
  candidates: [{ ticker: "AAA", market: "US", picked: true, screenScore: 80 }],
  trades: [{
    ticker: "AAA",
    market: "US",
    mode: "live",
    strategy: "overnight",
    expectedMovePct: 1,
    actualReturnPct: 0.5,
    brokerNetCashPnl: 5,
  }],
  abstentions: [{ market: "UK", strategy: "overnight", status: "blocked", reason: "Stale quote" }],
  guardrails: [{ market: "UK", strategy: "overnight", note: "BLOCKED: stale quote" }],
  quoteFreshness: [{ source: "fmp", observations: 2, measured: 1, averageAgeMs: 500, maximumAgeMs: 500 }],
  failures: [{ source: "quotes", message: "provider timeout", at: 1, kind: "api_or_provider" }],
  slippage: [{ ticker: "AAA", side: "BUY", adverseSlippagePct: 0.1 }],
  model: {
    samples: 120,
    calibrationError: 0.05,
    governance: [{
      scope: "US",
      championVersionId: 2,
      comparisonVersionId: 3,
      outcomes: 40,
      calibrationError: 0.05,
      comparisonCalibrationError: 0.04,
      readyForManualPromotion: false,
    }],
  },
  unusual: ["quotes: provider timeout"],
});

describe("daily operational review", () => {
  it("is deterministic for identical evidence and preserves the original generation time", () => {
    const first = buildDailyOperationalReview(snapshot(), new Date("2026-10-01T22:00:00Z"));
    const again = buildDailyOperationalReview(snapshot(), new Date("2026-10-01T23:00:00Z"), first);

    expect(again.contentHash).toBe(first.contentHash);
    expect(again.revision).toBe(1);
    expect(again.generatedAt).toBe(first.generatedAt);
    expect(again.updatedAt).toBe("2026-10-01T23:00:00.000Z");
    expect(again.coverage.brokerCashPnl).toEqual({ measured: 1, total: 1 });
    expect(again.coverage.quoteAge).toEqual({ measured: 1, total: 2 });
  });

  it("increments the revision when persisted evidence changes", () => {
    const first = buildDailyOperationalReview(snapshot(), new Date("2026-10-01T22:00:00Z"));
    const changed = snapshot();
    changed.unusual.push("AAA exceeded movement threshold");
    const updated = buildDailyOperationalReview(changed, new Date("2026-10-01T23:00:00Z"), first);

    expect(updated.contentHash).not.toBe(first.contentHash);
    expect(updated.revision).toBe(2);
    expect(updated.coverage.tradeOutcomes).toBe(true);
    expect(updated.coverage.governance).toBe(true);
  });
});
