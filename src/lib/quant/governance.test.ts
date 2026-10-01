import { describe, expect, it } from "vitest";
import {
  calculateForwardMetrics,
  governanceThresholds,
  promotionReady,
  settingsFingerprint,
  type ForwardEvidence,
} from "./governance";

const evidence = (
  runId: number,
  probability: number,
  outcome: boolean,
  actualAfterCostPct: number,
  predictedTrade = true,
): ForwardEvidence => ({
  runId,
  probability,
  outcome,
  actualAfterCostPct,
  predictedTrade,
  selected: predictedTrade,
});

describe("model governance", () => {
  it("fingerprints settings canonically", () => {
    expect(settingsFingerprint({ b: 2, a: { y: 1, x: true } })).toBe(
      settingsFingerprint({ a: { x: true, y: 1 }, b: 2 }),
    );
    expect(settingsFingerprint({ a: 1 })).not.toBe(settingsFingerprint({ a: 2 }));
  });

  it("computes calibration, Brier, after-cost return, drawdown and trade frequency", () => {
    const rows = [
      evidence(1, 0.9, true, 10),
      evidence(2, 0.8, false, -10),
      evidence(3, 0.2, false, 5, false),
      evidence(4, 0.1, false, 5, false),
    ];
    const metrics = calculateForwardMetrics(rows);
    expect(metrics.brier).toBeCloseTo(0.175, 8);
    expect(metrics.baselineBrier).toBeCloseTo(0.1875, 8);
    expect(metrics.calibrationError).toBeCloseTo(0.3, 8);
    expect(metrics.meanAfterCostReturnPct).toBe(0);
    expect(metrics.maxDrawdownPct).toBeCloseTo(10, 8);
    expect(metrics.predictedTradeFrequency).toBe(0.5);
  });

  it("requires all evidence dimensions before manual promotion", () => {
    const threshold = { ...governanceThresholds(), promotionOutcomes: 4, promotionDays: 4, maxCalibrationError: 1 };
    const champion = calculateForwardMetrics([
      evidence(1, 0.7, true, 1),
      evidence(2, 0.7, false, -2),
      evidence(3, 0.4, false, 0, false),
      evidence(4, 0.4, true, 0, false),
    ]);
    const challenger = calculateForwardMetrics([
      evidence(1, 0.9, true, 2),
      evidence(2, 0.1, false, -1),
      evidence(3, 0.1, false, 0, false),
      evidence(4, 0.9, true, 0, false),
    ]);
    expect(promotionReady(champion, challenger, 4, 4, threshold)).toBe(true);
    expect(promotionReady(champion, { ...challenger, brier: champion.brier! + 0.01 }, 4, 4, threshold)).toBe(false);
    expect(promotionReady(champion, { ...challenger, meanAfterCostReturnPct: -5 }, 4, 4, threshold)).toBe(false);
    expect(promotionReady(champion, challenger, 3, 4, threshold)).toBe(false);
  });
});
