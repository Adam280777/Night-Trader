export type IntradayUniverseMode = "auto" | "hybrid" | "manual";

export interface UniverseSymbol {
  ticker: string;
  symbol: string;
  name: string;
  knowledgeScore: number;
}

export interface UniverseSelection {
  symbols: UniverseSymbol[];
  source: "automatic" | "hybrid" | "manual" | "bootstrap fallback";
}

function unique(rows: UniverseSymbol[], limit: number): UniverseSymbol[] {
  const seen = new Set<string>();
  const out: UniverseSymbol[] = [];
  for (const row of rows) {
    const key = row.ticker.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** Combine the continuously learned pool with optional operator symbols without duplicating names. */
export function selectUniverse(
  learned: UniverseSymbol[],
  manual: UniverseSymbol[],
  mode: IntradayUniverseMode,
  limit: number,
): UniverseSelection {
  if (mode === "manual") return { symbols: unique(manual, limit), source: "manual" };
  if (mode === "hybrid") return { symbols: unique([...manual, ...learned], limit), source: "hybrid" };
  if (learned.length > 0) return { symbols: unique(learned, limit), source: "automatic" };
  return { symbols: unique(manual, limit), source: "bootstrap fallback" };
}
