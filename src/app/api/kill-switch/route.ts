import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { on } = (await req.json().catch(() => ({}))) as { on?: boolean };
  const next = typeof on === "boolean" ? on : !(await getSettings()).killSwitch;
  return NextResponse.json({ killSwitch: (await updateSettings({ killSwitch: next })).killSwitch });
}
