import { describe, expect, it } from "vitest";
import { selectUniverse, type UniverseSymbol } from "./universe";

const row = (ticker: string): UniverseSymbol => ({ ticker, symbol: ticker, name: ticker, knowledgeScore: 1 });

describe("selectUniverse", () => {
  it("uses the learned full-market pool in automatic mode", () => {
    const result = selectUniverse([row("AUTO1"), row("AUTO2")], [row("MANUAL")], "auto", 10);
    expect(result.source).toBe("automatic");
    expect(result.symbols.map((item) => item.ticker)).toEqual(["AUTO1", "AUTO2"]);
  });

  it("falls back to bootstrap symbols before continuous study has evidence", () => {
    const result = selectUniverse([], [row("BOOT")], "auto", 10);
    expect(result.source).toBe("bootstrap fallback");
    expect(result.symbols[0].ticker).toBe("BOOT");
  });

  it("merges manual overrides first and removes duplicates in hybrid mode", () => {
    const result = selectUniverse([row("SHARED"), row("AUTO")], [row("MANUAL"), row("SHARED")], "hybrid", 10);
    expect(result.symbols.map((item) => item.ticker)).toEqual(["MANUAL", "SHARED", "AUTO"]);
  });

  it("honours the requested pool limit", () => {
    expect(selectUniverse([row("A"), row("B"), row("C")], [], "auto", 2).symbols).toHaveLength(2);
  });
});
