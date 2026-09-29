import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { answerQuestion } from "@/lib/quant/assistant";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await getDb().select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.id)).limit(200);
  return NextResponse.json(rows);
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
