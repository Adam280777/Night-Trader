import { asc } from "drizzle-orm";
import { PageHeader } from "@/components/ui";
import { ChatBox } from "@/components/chat-box";
import { getDb, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Chat() {
  const rows = await getDb().select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.id)).limit(200);
  return (
    <>
      <PageHeader title="Ask the AI" subtitle="Ask why it made a decision, what it has learned, or how it is doing. It only answers from its real records." />
      <ChatBox initial={rows.map((r) => ({ id: r.id, role: r.role, content: r.content }))} />
    </>
  );
}
