import { describe, expect, it } from "vitest";
import { slice } from "./study";
import type { SymbolRef } from "../lib/quant/screener";

const universe = (n: number): SymbolRef[] => Array.from({ length: n }, (_, i) => ({ ticker: `T${i}`, name: `Name ${i}`, yahoo: `Y${i}` }));

describe("study rotation", () => {
  it("takes the next slice from the cursor", () => {
    expect(slice(universe(10), 3, 4).map((s) => s.yahoo)).toEqual(["Y3", "Y4", "Y5", "Y6"]);
  });

  it("wraps around the end so the rotation is continuous", () => {
    expect(slice(universe(10), 8, 4).map((s) => s.yahoo)).toEqual(["Y8", "Y9", "Y0", "Y1"]);
  });

  it("covers the whole universe over successive rounds without gaps", () => {
    const u = universe(23);
    const seen = new Set<string>();
    let cursor = 0;
    for (let round = 0; round < 5; round++) {
      const batch = slice(u, cursor, 5);
      for (const s of batch) seen.add(s.yahoo);
      cursor = (cursor + batch.length) % u.length;
    }
    expect(seen.size).toBe(23);
  });

  it("never returns more than the universe holds", () => {
    expect(slice(universe(3), 0, 10)).toHaveLength(3);
  });

  it("handles an empty universe", () => {
    expect(slice([], 0, 5)).toEqual([]);
  });

  it("tolerates a cursor past the end", () => {
    expect(slice(universe(5), 12, 2).map((s) => s.yahoo)).toEqual(["Y2", "Y3"]);
  });
});
