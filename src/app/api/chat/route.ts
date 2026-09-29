import { NextResponse } from "next/server";
import { asc, desc } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { chatText } from "@/lib/ai/llm";
import { getActiveLessons, getPerformanceStats } from "@/lib/ai/memory";
import { getHistory } from "@/lib/queries";

export const dynamic = "force-dynamic";

const SYSTEM = `You are the AI behind an overnight-trading dashboard. Each day you research stocks, buy at most one shortly before the market closes and sell it at the next open.
You are talking to the person who owns the account. Answer using ONLY the data provided below about your real decisions, trades, results and lessons; if it is not in the data, say you don't know rather than guessing.
Be candid about mistakes and uncertainty, never promise returns, and keep answers short and plain. This is not financial advice.`;

export async function GET() {
  const rows = getDb().select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.id)).limit(200).all();
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  if (!message?.trim()) return NextResponse.json({ error: "Empty message" }, { status: 400 });
  const db = getDb();

  const history = getHistory(15).map(({ run, decision, trade }) => ({
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
  const context = JSON.stringify({ stats: getPerformanceStats(), lessons: getActiveLessons(30).map((l) => l.text), recentRuns: history }, null, 1);

  const prior = db.select().from(schema.chatMessages).orderBy(desc(schema.chatMessages.id)).limit(8).all().reverse();
  const transcript = prior.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`).join("\n");
  const input = `## Data\n${context}\n\n## Conversation so far\n${transcript}\n\nUser: ${message.trim()}`;

  db.insert(schema.chatMessages).values({ role: "user", content: message.trim() }).run();
  try {
    const answer = await chatText(SYSTEM, input);
    const row = db.insert(schema.chatMessages).values({ role: "assistant", content: answer }).returning().get();
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 502 });
  }
}
