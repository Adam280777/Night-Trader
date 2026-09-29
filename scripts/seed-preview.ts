// Dev-only: fills a scratch database with realistic-looking data to preview the UI.
// Usage: DATABASE_PATH=./data/preview.db npx tsx scripts/seed-preview.ts
import { ensureMigrated, getDb, schema } from "../src/lib/db";

async function main() {
await ensureMigrated();
const db = getDb();
const day = 86_400_000;
const now = Date.now();

const picks = [
  ["AAPL_US_EQ", "Apple", "US", 0.92], ["NVDA_US_EQ", "NVIDIA", "US", -0.71], ["MSFT_US_EQ", "Microsoft", "US", 0.35],
  ["VODl_EQ", "Vodafone", "UK", -0.4], ["TSLA_US_EQ", "Tesla", "US", 1.6], ["AMZN_US_EQ", "Amazon", "US", 0.58],
  ["SHELl_EQ", "Shell", "UK", 0.22], ["META_US_EQ", "Meta", "US", -1.1], ["GOOGL_US_EQ", "Alphabet", "US", 0.81],
] as const;

let equity = 1000;
for (let i = 0; i < picks.length; i++) {
  const [ticker, name, market, ret] = picks[i];
  const date = new Date(now - (picks.length - i + 1) * day).toISOString().slice(0, 10);
  const run = await db.insert(schema.runs).values({ tradingDate: date, market, mode: "dry", status: "closed", sessionCloseAt: new Date(now - (picks.length - i + 1) * day) }).returning({ id: schema.runs.id }).get();
  const conf = 0.6 + (i % 4) * 0.08;
  const d = await db.insert(schema.decisions).values({
    runId: run.id, ticker, name, action: "BUY", confidence: conf, investPct: 0.5, expectedMovePct: 1.1,
    thesis: `${name} has positive after-hours momentum following a supportive analyst note and strong sector flows. Volume is well above average into the close.`,
    risks: "Broad market reversal or an unexpected macro headline before the open.", exitPlan: "Sell at the next open.",
    sources: [{ title: "Example news article", url: "https://example.com/news" }], guardrailNotes: ["Position capped at 25% of account."], approval: "approved",
  }).returning({ id: schema.decisions.id }).get();
  const pnl = 250 * (ret / 100);
  await db.insert(schema.trades).values({ runId: run.id, decisionId: d.id, ticker, name, quantity: 3, entryPrice: 100, entryAt: new Date(now - (picks.length - i + 1) * day), exitPrice: 100 * (1 + ret / 100), exitAt: new Date(now - (picks.length - i) * day), pnl, pnlPct: ret, status: "closed", review: "thesis_right: Momentum carried into the open as expected." }).run();
  await db.insert(schema.candidates).values([
    { runId: run.id, ticker, name, screenScore: 8.2, picked: true, refPrice: 100, nextOpenPrice: 100 + ret, overnightReturnPct: ret, researchSummary: "Chosen", research: { summary: "Strong momentum and volume into the close.", catalysts: ["Analyst upgrade"], risks: ["Market reversal"] } },
    { runId: run.id, ticker: "OTHER_US_EQ", name: "Other Co", screenScore: 6.1, picked: false, refPrice: 50, nextOpenPrice: 50.1, overnightReturnPct: 0.2, researchSummary: "Not chosen: weaker catalyst." },
  ]).run();
  if (i % 3 === 0) await db.insert(schema.lessons).values({ tradeId: 1, text: "Gap-ups following analyst upgrades continued overnight more often than gaps driven by low-volume news.", tags: ["momentum"] }).run();
  equity += pnl;
  await db.insert(schema.equitySnapshots).values({ ts: new Date(now - (picks.length - i) * day), totalValue: equity, cash: equity, mode: "dry" }).run();
}
await db.insert(schema.equitySnapshots).values({ ts: new Date(now), totalValue: equity, cash: equity, mode: "dry" }).run();

// A live run waiting for approval
const live = await db.insert(schema.runs).values({ tradingDate: new Date().toISOString().slice(0, 10), market: "US", mode: "dry", status: "awaiting_approval", sessionCloseAt: new Date(now + 40 * 60_000) }).returning({ id: schema.runs.id }).get();
await db.insert(schema.decisions).values({
  runId: live.id, ticker: "AMD_US_EQ", name: "Advanced Micro Devices", action: "BUY", confidence: 0.74, investPct: 0.6, expectedMovePct: 1.4,
  thesis: "AMD is holding gains into the close after a well-received product announcement, with volume 1.8x average and semiconductor peers strong.", risks: "Sector-wide selloff after Asian markets open.", exitPlan: "Sell at the next open.",
  approval: "pending", approvalDeadline: new Date(now + 15 * 60_000), guardrailNotes: [],
}).run();
await db.insert(schema.eventLog).values([{ level: "info", source: "pipeline", message: "Shortlist (US): AMD, NVDA, AAPL, MSFT", runId: live.id }, { level: "warn", source: "pipeline", message: "Research failed for one candidate", runId: live.id }]).run();
await db.insert(schema.settings).values({ key: "_heartbeat", value: Date.now() }).onConflictDoUpdate({ target: schema.settings.key, set: { value: Date.now() } }).run();
console.log("Seeded.");
}
main().catch((e) => { console.error(e); process.exit(1); });
