export function money(v: number | null | undefined, ccy = "GBP"): string {
  if (v == null || Number.isNaN(v)) return "n/a";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: ccy }).format(v);
  } catch {
    return `${v.toFixed(2)} ${ccy}`;
  }
}

export function pct(v: number | null | undefined, digits = 2, signed = true): string {
  if (v == null || Number.isNaN(v)) return "n/a";
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function when(d: Date | number | null | undefined): string {
  if (d == null) return "n/a";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function tone(v: number | null | undefined): "good" | "bad" | "neutral" {
  if (v == null || v === 0) return "neutral";
  return v > 0 ? "good" : "bad";
}

export type Tone = "good" | "bad" | "warn" | "info" | "neutral";

export const STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  scheduled: { label: "Starting", tone: "info", hint: "Run created, about to start." },
  screening: { label: "Screening", tone: "info", hint: "Filtering the market down to a shortlist." },
  researching: { label: "Researching", tone: "info", hint: "Reading news and analysing each candidate." },
  deciding: { label: "Deciding", tone: "info", hint: "Picking one stock, or deciding to sit out." },
  awaiting_approval: { label: "Needs your approval", tone: "warn", hint: "Approve or reject the proposed trade." },
  ready_to_buy: { label: "Ready to buy", tone: "info", hint: "Will buy shortly before the close." },
  executing: { label: "Buying", tone: "info", hint: "Order is being placed." },
  holding: { label: "Holding overnight", tone: "good", hint: "Will sell at the next open." },
  exiting: { label: "Selling", tone: "info", hint: "Sell order is working." },
  closed: { label: "Closed", tone: "neutral", hint: "Trade completed." },
  no_trade: { label: "No trade", tone: "neutral", hint: "Sat out today." },
  blocked: { label: "Blocked by guardrails", tone: "warn", hint: "A safety rule stopped this trade." },
  failed: { label: "Failed", tone: "bad", hint: "Something went wrong; see the log." },
  skipped: { label: "Skipped", tone: "neutral", hint: "Not run." },
};
