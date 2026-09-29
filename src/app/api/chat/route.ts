import { NextResponse } from "next/server";
import { asc, desc } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { chatText } from "@/lib/ai/llm";
import { getActiveLessons, getPerformanceStats } from "@/lib/ai/memory";
import { getHistory, getWorkerStatus } from "@/lib/queries";
import { currentMode, getEnvConfig, getSettings } from "@/lib/config";
import { getAccountState, tryClient } from "@/lib/account";

export const dynamic = "force-dynamic";

const SYSTEM = `You are the AI behind an overnight-trading dashboard connected to the owner's Trading 212 account. You are talking to the account owner.

How the system works (you can explain this freely):
1. Each trading day, shortly before the market closes (US and UK), a scheduler starts a run. It is triggered by an external timer, so it works with the owner's PC off.
2. Screen: the app pulls the tradable instrument list from Trading 212, filters to liquid non-leveraged stocks, and ranks them with market data (momentum, volume, gaps, upcoming earnings) from Yahoo Finance to a shortlist of about 8.
3. Research: for every shortlisted stock, the AI does live web research (news, catalysts, risks, earnings) with cited sources, plus a read of the overall market.
4. Decide: one decision picks a single stock or "no trade", with confidence, how much to invest, thesis and exit plan. It uses recent performance stats and lessons from past trades.
5. Guardrails (hard limits the AI cannot override): position size caps, minimum cash, daily/weekly loss breaker, no leveraged products, cost checks, kill switch. Optional approval step before buying.
6. Buy shortly before the close with a market order, sell at the next open, then review the result and write a lesson.
Modes: dry-run (no orders), demo (Trading 212 practice money), live (real money).

Rules for answering:
- The "Live snapshot" and "Data" sections below come straight from Trading 212 and the app's database. Use them for anything about the account, positions, settings, past runs and results. If something is not there, say so plainly instead of guessing.
- For questions about a company or the market you may search the web, and you should say when you did.
- Never claim you cannot access Trading 212: the snapshot is fetched from it on each message. If the snapshot reports an error, tell the owner what the error says.
- Be candid about mistakes and uncertainty, never promise returns, keep answers short and plain. This is not financial advice.`;

async function liveSnapshot() {
  const snap: Record<string, unknown> = {};
  try {
    const settings = await getSettings();
    snap.settings = {
      mode: await currentMode(settings),
      approvalMode: settings.approvalMode,
      killSwitch: settings.killSwitch,
      markets: settings.markets,
      tradingEnabled: settings.tradingEnabled,
    };
    const worker = await getWorkerStatus();
    snap.scheduler = { online: worker.alive, lastTick: worker.lastHeartbeat ? new Date(worker.lastHeartbeat).toISOString() : null };
  } catch (err) {
    snap.settingsError = String(err).slice(0, 150);
  }
  try {
    const client = await tryClient();
    if (!client) {
      snap.trading212 = "No Trading 212 keys are set (add them in Settings)";
    } else {
      const [account, positions] = await Promise.all([getAccountState(client), client.getPositions()]);
      snap.trading212 = {
        environment: (await getEnvConfig()).t212Env,
        totalValue: account.totalValue,
        availableCash: account.availableCash,
        currency: account.currency,
        positions: positions.map((p) => ({
          ticker: p.instrument.ticker,
          name: p.instrument.name,
          quantity: p.quantity,
          averagePrice: p.averagePricePaid,
          currentPrice: p.currentPrice,
          unrealisedPnl: p.walletImpact?.unrealizedProfitLoss,
        })),
      };
    }
  } catch (err) {
    snap.trading212 = `Could not fetch from Trading 212: ${String(err).slice(0, 200)}`;
  }
  return snap;
}

export async function GET() {
  const rows = await getDb().select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.id)).limit(200);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  if (!message?.trim()) return NextResponse.json({ error: "Empty message" }, { status: 400 });
  const db = getDb();

  const history = (await getHistory(15)).map(({ run, decision, trade }) => ({
    date: run.tradingDate,
    market: run.market,
    status: run.status,
    note: run.error,
    ticker: decision?.ticker,
    action: decision?.action,
    confidence: decision?.confidence,
    thesis: decision?.thesis,
    risks: decision?.risks,
    resultPct: trade?.pnlPct,
    review: trade?.review,
  }));
  const context = JSON.stringify({ stats: await getPerformanceStats(), lessons: (await getActiveLessons(30)).map((l) => l.text), recentRuns: history }, null, 1);

  const prior = (await db.select().from(schema.chatMessages).orderBy(desc(schema.chatMessages.id)).limit(8)).reverse();
  const transcript = prior.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`).join("\n");
  const snapshot = JSON.stringify(await liveSnapshot(), null, 1);
  const input = `## Live snapshot (fetched from Trading 212 just now)\n${snapshot}\n\n## Data\n${context}\n\n## Conversation so far\n${transcript}\n\nUser: ${message.trim()}`;

  await db.insert(schema.chatMessages).values({ role: "user", content: message.trim() }).run();
  try {
    const answer = await chatText(SYSTEM, input, { webSearch: true });
    const [row] = await db.insert(schema.chatMessages).values({ role: "assistant", content: answer }).returning();
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 502 });
  }
}
