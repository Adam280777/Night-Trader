import { NextResponse } from "next/server";
import { asc, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { currentSession } from "@/lib/chat";
import { answerQuestion } from "@/lib/quant/assistant";

export const dynamic = "force-dynamic";

/** Old conversations are dropped outright; the model answers from its records, not the chat log. */
const RETAIN_MS = 30 * 86_400_000;

export async function GET() {
  const db = getDb();
  await db.delete(schema.chatMessages).where(lt(schema.chatMessages.createdAt, new Date(Date.now() - RETAIN_MS)));
  const rows = await db.select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.id)).limit(200);
  return NextResponse.json(currentSession(rows));
}

export async function POST(req: Request) {
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  if (!message?.trim()) return NextResponse.json({ error: "Empty message" }, { status: 400 });
  const db = getDb();

  await db.insert(schema.chatMessages).values({ role: "user", content: message.trim() }).run();
  try {
    const answer = await answerQuestion(message);
    const [row] = await db.insert(schema.chatMessages).values({ role: "assistant", content: answer }).returning();
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 502 });
  }
}

/** Clear the conversation. The model's knowledge lives in its own records, so nothing is lost. */
export async function DELETE() {
  await getDb().delete(schema.chatMessages);
  return NextResponse.json({ ok: true });
}
