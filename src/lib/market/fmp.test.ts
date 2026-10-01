import { describe, expect, it } from "vitest";
import { providerDivergencePct } from "./data";
import { parseFmpEconomicResponse, parseFmpEarningsResponse, parseFmpQuoteResponse } from "./fmp";

describe("FMP response validation", () => {
  it("parses the quote fields used by execution", () => {
    const quote = parseFmpQuoteResponse([{
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 250.5,
      changePercentage: 1.2,
      volume: 10_000,
      averageVolume: 20_000,
      marketCap: 3_000_000,
      timestamp: 1_800_000_000,
    }])[0];
    expect(quote.symbol).toBe("AAPL");
    expect(quote.price).toBe(250.5);
  });

  it("rejects success-shaped quotes with invalid prices", () => {
    expect(() => parseFmpQuoteResponse([{ symbol: "AAPL", price: 0, timestamp: 1_800_000_000 }])).toThrow();
  });

  it("parses earnings and economic calendar timestamps", () => {
    const earnings = parseFmpEarningsResponse([{ symbol: "AAPL", date: "2026-10-29", time: "amc" }]);
    const events = parseFmpEconomicResponse([{ date: "2026-10-02 12:30:00", country: "US", event: "Nonfarm Payrolls", impact: "High" }]);
    expect(earnings[0].date.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(events[0].at.toISOString()).toBe("2026-10-02T12:30:00.000Z");
  });
});

describe("provider disagreement", () => {
  it("uses a symmetric percentage difference", () => {
    expect(providerDivergencePct(100, 101)).toBeCloseTo(0.995, 3);
    expect(providerDivergencePct(101, 100)).toBeCloseTo(0.995, 3);
  });
});
