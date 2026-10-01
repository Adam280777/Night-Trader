import { describe, expect, it } from "vitest";
import { DATA_RESET_CONFIRMATIONS, DATA_RESET_TARGETS, resetRequiresKillSwitch } from "./data-reset-config";

describe("data reset confirmations", () => {
  it("requires a distinct explicit phrase for every destructive scope", () => {
    expect(new Set(Object.values(DATA_RESET_CONFIRMATIONS)).size).toBe(DATA_RESET_TARGETS.length);
    expect(DATA_RESET_CONFIRMATIONS).toEqual({
      logs: "CLEAR LOGS",
      trading: "DELETE TRADING DATA",
      research: "DELETE RESEARCH DATA",
      all: "RESET ALL DATA",
    });
  });

  it("pauses trading after deleting strategy evidence but not after clearing logs", () => {
    expect(resetRequiresKillSwitch("logs")).toBe(false);
    expect(resetRequiresKillSwitch("trading")).toBe(true);
    expect(resetRequiresKillSwitch("research")).toBe(true);
    expect(resetRequiresKillSwitch("all")).toBe(true);
  });
});
