import { asc } from "drizzle-orm";
import { PageHeader } from "@/components/ui";
import { ChatBox } from "@/components/chat-box";
import { currentSession } from "@/lib/chat";
import { getDb, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Chat() {
  const rows = await getDb().select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.id)).limit(200);
  const session = currentSession(rows);
  return (
    <>
      <PageHeader
        title="Talk to the quant model"
        subtitle="Ask why it decided what it did, what it is researching, what it has learned, or how it is configured. Every answer is computed from its own records — nothing is generated or guessed."
      />
      <ChatBox initial={session.map((r) => ({ id: r.id, role: r.role, content: r.content }))} />
    </>
  );
}
