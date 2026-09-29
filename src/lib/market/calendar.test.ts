import { describe, expect, it } from "vitest";
import { currentOrNextSession, nextSessionAfter, sessionsFromEvents } from "./calendar";

const ev = (type: "OPEN" | "CLOSE" | "BREAK_START" | "BREAK_END", date: string) => ({ type, date });

describe("calendar", () => {
  const sessions = sessionsFromEvents([
    ev("CLOSE", "2026-09-29T20:00:00Z"),
    ev("OPEN", "2026-09-29T13:30:00Z"),
    ev("OPEN", "2026-09-30T13:30:00Z"),
    ev("CLOSE", "2026-09-30T18:00:00Z"), // early close
  ]);

  it("pairs unsorted open/close events, keeping early closes", () => {
    expect(sessions).toHaveLength(2);
    expect(sessions[1].close.toISOString()).toBe("2026-09-30T18:00:00.000Z");
  });

  it("ignores lunch breaks", () => {
    const s = sessionsFromEvents([
      ev("OPEN", "2026-09-29T08:00:00Z"),
      ev("BREAK_START", "2026-09-29T11:00:00Z"),
      ev("BREAK_END", "2026-09-29T12:00:00Z"),
      ev("CLOSE", "2026-09-29T16:30:00Z"),
    ]);
    expect(s).toHaveLength(1);
  });

  it("finds the current and next-day exit session", () => {
    const now = new Date("2026-09-29T19:30:00Z");
    expect(currentOrNextSession(sessions, now)?.close.toISOString()).toBe("2026-09-29T20:00:00.000Z");
    expect(nextSessionAfter(sessions, now)?.open.toISOString()).toBe("2026-09-30T13:30:00.000Z");
  });
});
