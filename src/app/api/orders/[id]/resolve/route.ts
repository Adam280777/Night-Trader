import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/** For an order whose outcome the app could not determine: the user checked Trading 212 and tells us what happened. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const o = db.select().from(schema.orders).where(eq(schema.orders.id, Number(id))).get();
  if (!o) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (o.status !== "unknown") return NextResponse.json({ error: "Order is not in an unknown state" }, { status: 409 });
  db.update(schema.orders)
    .set({ status: "cancelled", error: `${o.error ?? ""} | Resolved manually by user`, updatedAt: new Date() })
    .where(eq(schema.orders.id, o.id))
    .run();
  log("warn", "order", `Order #${o.id} (${o.side} ${o.ticker}) marked as resolved by you. Trading can resume.`, o.runId ?? undefined);
  return NextResponse.json({ ok: true });
}
