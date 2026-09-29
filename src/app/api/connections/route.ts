import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnvConfig, updateSettings, writeConnection } from "@/lib/config";
import { connectionStatus, testOpenAI, testT212 } from "@/lib/connections";
import { openTrade } from "@/lib/account";

export const dynamic = "force-dynamic";

const Body = z.object({
  t212Env: z.enum(["demo", "live"]).optional(),
  t212Key: z.string().trim().max(500).optional(),
  t212Secret: z.string().trim().max(500).optional(),
  openaiKey: z.string().trim().max(500).optional(),
  openaiModel: z.string().trim().max(100).optional(),
});

export async function GET() {
  return NextResponse.json(await connectionStatus());
}

/** Verifies whatever was entered (merged with what is already saved) and only saves what works. */
export async function PUT(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const b = parsed.data;
  const cur = await getEnvConfig();
  const results: Record<string, { ok: boolean; detail: string }> = {};
  const save: Parameters<typeof writeConnection>[0] = {};

  const t212Changed = b.t212Key || b.t212Secret || (b.t212Env && b.t212Env !== cur.t212Env);
  if (t212Changed) {
    if (await openTrade()) return NextResponse.json({ error: "A position is currently open. Change Trading 212 settings after it has been sold." }, { status: 409 });
    const env = b.t212Env ?? cur.t212Env;
    const r = await testT212(env, b.t212Key || cur.t212Key, b.t212Secret || cur.t212Secret);
    results.t212 = r;
    if (r.ok) Object.assign(save, { t212Env: env, t212Key: b.t212Key, t212Secret: b.t212Secret });
  }

  const openaiChanged = b.openaiKey || (b.openaiModel && b.openaiModel !== cur.openaiModel);
  if (openaiChanged) {
    const r = await testOpenAI(b.openaiKey || cur.openaiKey, b.openaiModel || cur.openaiModel);
    results.openai = r;
    if (r.ok) Object.assign(save, { openaiKey: b.openaiKey, openaiModel: b.openaiModel });
  }

  if (Object.keys(save).length > 0) {
    await writeConnection(save);
    // A different account or environment must never inherit an earlier live confirmation.
    if (results.t212?.ok) await updateSettings({ liveConfirmed: false });
  }
  return NextResponse.json({ results, status: await connectionStatus() });
}

/** Tests the currently saved keys without changing anything. */
export async function POST() {
  const c = await getEnvConfig();
  const [t212, openai] = await Promise.all([testT212(c.t212Env, c.t212Key, c.t212Secret), testOpenAI(c.openaiKey, c.openaiModel)]);
  return NextResponse.json({ results: { t212, openai }, status: await connectionStatus() });
}
