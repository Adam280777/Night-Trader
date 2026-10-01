import { NextResponse } from "next/server";
import { z } from "zod";
import { governanceReport, promoteChallenger, rollback } from "@/lib/quant/governance";

export const dynamic = "force-dynamic";

const ScopeSchema = z.enum(["shared", "US", "UK"]);
const ActionSchema = z.object({
  action: z.enum(["promote", "rollback"]),
  scope: ScopeSchema,
  reason: z.string().trim().min(3).max(500),
});

export async function GET() {
  const reports = await Promise.all(["shared", "US", "UK"].map((scope) => governanceReport(ScopeSchema.parse(scope))));
  return NextResponse.json({ reports: reports.filter(Boolean), automaticPromotion: false });
}

export async function POST(req: Request) {
  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "action, scope and a reason of at least 3 characters are required" }, { status: 400 });
  }
  try {
    const report =
      parsed.data.action === "promote"
        ? await promoteChallenger(parsed.data.scope, parsed.data.reason)
        : await rollback(parsed.data.scope, parsed.data.reason);
    return NextResponse.json({ ok: true, report });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
