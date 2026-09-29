import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnvConfig } from "@/lib/config";
import { listModels } from "@/lib/connections";
import { PROVIDER_IDS } from "@/lib/ai/providers";

export const dynamic = "force-dynamic";

const Body = z.object({ provider: z.enum(PROVIDER_IDS), key: z.string().trim().max(500).optional() });

/** Lists the models a key can use. Uses the key from the request, else the one already saved. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { provider, key } = parsed.data;
  const saved = (await getEnvConfig()).providers[provider].key;
  return NextResponse.json(await listModels(provider, key || saved));
}
