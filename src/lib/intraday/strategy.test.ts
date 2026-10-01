import { describe, expect, it } from "vitest";
import { IntradaySchema } from "../config";
import type { Bar } from "../market/data";
import { analyseIntraday } from "./strategy";

function bars(count = 30, rising = true): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const close = rising ? 100 + index * 0.12 : 100 - index * 0.12;
    return {
      date: new Date(Date.UTC(2026, 8, 30, 14, index * 5)),
      open: close - 0.05,
      high: close + 0.08,
      low: close - 0.1,
      close,
      volume: 100_000 + index * 8_000,
    };
  });
}

describe("analyseIntraday", () => {
  const settings = IntradaySchema.parse({ minScore: 55, minRelativeVolume: 1, minMomentumPct: 0.1 });

  it("recognises a liquid rising momentum setup", () => {
    const signal = analyseIntraday("TEST", bars(), settings);
    expect(signal).not.toBeNull();
    expect(signal!.score).toBeGreaterThanOrEqual(settings.minScore);
    expect(signal!.confidence).toBeGreaterThan(0.5);
  });

  it("rejects a falling trend", () => {
    expect(analyseIntraday("TEST", bars(30, false), settings)).toBeNull();
  });

  it("rejects incomplete sessions", () => {
    expect(analyseIntraday("TEST", bars(8), settings)).toBeNull();
  });
});
