import { describe, expect, it } from "vitest";
import { overlappingOvernightRun } from "./coordination";

describe("overlappingOvernightRun", () => {
  const now = Date.UTC(2026, 9, 1, 14, 0);

  it("reserves capital when a maximum intraday hold reaches the overnight buy window", () => {
    const run = { id: 7, sessionCloseAt: new Date(now + 100 * 60_000) };
    expect(overlappingOvernightRun([run], now, 90, 10)?.id).toBe(7);
  });

  it("allows an intraday entry that must finish well before the overnight window", () => {
    const run = { id: 8, sessionCloseAt: new Date(now + 180 * 60_000) };
    expect(overlappingOvernightRun([run], now, 60, 10)).toBeNull();
  });

  it("ignores runs whose close has already passed", () => {
    const run = { id: 9, sessionCloseAt: new Date(now - 1) };
    expect(overlappingOvernightRun([run], now, 90, 10)).toBeNull();
  });
});
