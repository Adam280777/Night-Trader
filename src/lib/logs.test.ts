import { describe, expect, it } from "vitest";
import { csvField, logsToCsv, parseLevels, type LogRow } from "./logs";

describe("log csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(42)).toBe("42");
  });

  it("defuses spreadsheet formulas in text but leaves negative numbers alone", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("+1 call")).toBe("'+1 call");
    expect(csvField("-cmd")).toBe("'-cmd");
    expect(csvField(-5)).toBe("-5");
  });

  it("writes a header and puts the oldest row first", () => {
    const rows: LogRow[] = [
      { id: 2, ts: Date.UTC(2026, 0, 1, 12), level: "warn", source: "study", message: "newer", runId: 7 },
      { id: 1, ts: Date.UTC(2026, 0, 1, 11), level: "info", source: "scheduler", message: "older, with comma", runId: null },
    ];
    const lines = logsToCsv(rows).trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,time_utc,time_london,level,source,run_id,message,detail_json");
    expect(lines[1]).toMatch(/^1,2026-01-01T11:00:00\.000Z,.*,info,scheduler,,"older, with comma",$/);
    expect(lines[2]).toMatch(/^2,.*,warn,study,7,newer,$/);
  });

  it("parses level filters and drops unknown ones", () => {
    expect(parseLevels("warn, ERROR,bogus")).toEqual(["warn", "error"]);
    expect(parseLevels("")).toBeUndefined();
    expect(parseLevels(null)).toBeUndefined();
  });
});
