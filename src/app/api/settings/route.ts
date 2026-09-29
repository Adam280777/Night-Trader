import { NextResponse } from "next/server";
import { z } from "zod";
import { SettingsPatchSchema, getEnvConfig, getSettings, updateSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json((await getSettings()));
}

const LIVE_PHRASE = "TRADE LIVE";

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const { confirmText, ...patchRaw } = body;
  const parsed = SettingsPatchSchema.safeParse(patchRaw);
  if (!parsed.success) return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  const patch = parsed.data;

  const env = (await getEnvConfig()).t212Env;
  if (patch.liveConfirmed === true) {
    if (env !== "live") return NextResponse.json({ error: "T212_ENV is not 'live'; nothing to confirm." }, { status: 400 });
    if (confirmText !== LIVE_PHRASE) return NextResponse.json({ error: `Type ${LIVE_PHRASE} to confirm live trading.` }, { status: 400 });
  }
  // Turning trading off always revokes the live confirmation so it has to be re-typed next time.
  if (patch.tradingEnabled === false) patch.liveConfirmed = false;

  return NextResponse.json(await updateSettings(patch));
}
