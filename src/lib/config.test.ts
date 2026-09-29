import { describe, expect, it } from "vitest";
import { SettingsPatchSchema, SettingsSchema } from "./config";
import { currentSession, SESSION_IDLE_MS } from "./chat";

describe("settings patch", () => {
  /**
   * The bug this guards against: `.partial()` leaves each field's `.default()` in place, so a
   * one-key patch parsed to a fully populated object and `updateSettings` wrote every default back.
   * Turning off "ask me before every trade" therefore also turned off "place orders".
   */
  it("returns only the keys it was given", () => {
    const parsed = SettingsPatchSchema.parse({ approvalMode: false });
    expect(parsed).toEqual({ approvalMode: false });
    expect(Object.keys(parsed)).toHaveLength(1);
  });

  it("does not disturb any sibling setting", () => {
    const current = SettingsSchema.parse({ tradingEnabled: true, approvalMode: true, maxPositionPct: 0.4 });
    const merged = SettingsSchema.parse({ ...current, ...SettingsPatchSchema.parse({ approvalMode: false }) });
    expect(merged.approvalMode).toBe(false);
    expect(merged.tradingEnabled).toBe(true);
    expect(merged.maxPositionPct).toBe(0.4);
  });

  it("keeps nested patches shallow so untouched quant keys survive", () => {
    const parsed = SettingsPatchSchema.parse({ quant: { kellyFraction: 0.3 } });
    expect(parsed.quant).toEqual({ kellyFraction: 0.3 });
  });

  it("still rejects invalid values", () => {
    expect(SettingsPatchSchema.safeParse({ approvalMode: "yes" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ maxPositionPct: 5 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ quant: { kellyFraction: 99 } }).success).toBe(false);
  });

  it("accepts an empty patch", () => {
    expect(SettingsPatchSchema.parse({})).toEqual({});
  });
});

describe("chat sessions", () => {
  const at = (minutes: number) => ({ createdAt: new Date(minutes * 60_000) });

  it("keeps a continuous conversation together", () => {
    const rows = [at(0), at(1), at(2)];
    expect(currentSession(rows, 3 * 60_000)).toHaveLength(3);
  });

  it("starts fresh after a long silence", () => {
    const gap = SESSION_IDLE_MS / 60_000 + 10;
    const rows = [at(0), at(1), at(gap), at(gap + 1)];
    const session = currentSession(rows, (gap + 2) * 60_000);
    expect(session).toHaveLength(2);
    expect(session[0]).toBe(rows[2]);
  });

  it("retires a conversation that has itself gone quiet", () => {
    const rows = [at(0), at(1)];
    expect(currentSession(rows, Date.now())).toHaveLength(0);
  });

  it("handles an empty log", () => {
    expect(currentSession([], Date.now())).toEqual([]);
  });
});
