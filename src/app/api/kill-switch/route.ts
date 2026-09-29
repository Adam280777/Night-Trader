import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { on } = (await req.json().catch(() => ({}))) as { on?: boolean };
  const next = typeof on === "boolean" ? on : !getSettings().killSwitch;
  return NextResponse.json({ killSwitch: updateSettings({ killSwitch: next }).killSwitch });
}
