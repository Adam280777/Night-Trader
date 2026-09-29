import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: "approve" | "reject" };
  if (action !== "approve" && action !== "reject") return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });

  const db = getDb();
  const d = await db.select().from(schema.decisions).where(eq(schema.decisions.id, Number(id))).get();
  if (!d) return NextResponse.json({ error: "Decision not found" }, { status: 404 });
  if (d.approval !== "pending") return NextResponse.json({ error: `Decision is already ${d.approval}` }, { status: 409 });
  if (d.approvalDeadline && d.approvalDeadline.getTime() < Date.now()) return NextResponse.json({ error: "The approval window has closed" }, { status: 409 });

  await db.update(schema.decisions).set({ approval: action === "approve" ? "approved" : "rejected" }).where(eq(schema.decisions.id, d.id)).run();
  await log("info", "approval", `You ${action === "approve" ? "approved" : "rejected"} ${d.ticker}.`, d.runId);
  // The scheduler moves the run forward on its next tick (within about a minute).
  return NextResponse.json({ ok: true });
}
