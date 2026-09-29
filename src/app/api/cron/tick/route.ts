import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ensureMigrated } from "@/lib/db";
import { tick } from "@/worker/scheduler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Called about once a minute by an external timer (cron-job.org, GitHub Actions, Vercel Cron). */
async function handle(req: Request) {
  if (!authorised(req)) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await ensureMigrated();
  const result = await tick();
  return NextResponse.json(result);
}

export const GET = handle;
export const POST = handle;
