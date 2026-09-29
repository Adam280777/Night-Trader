import { NextResponse } from "next/server";
import { MIN_PASSWORD_LENGTH, SESSION_COOKIE, createSession, setPassword, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { current?: unknown; next?: unknown } | null;
  if (typeof body?.current !== "string" || typeof body?.next !== "string") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (!verifyPassword(body.current)) return NextResponse.json({ error: "Current password is wrong" }, { status: 400 });
  if (body.next.length < MIN_PASSWORD_LENGTH) return NextResponse.json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });

  setPassword(body.next);
  // Every old session is now invalid, so sign this browser straight back in with a fresh one.
  const { token, maxAgeSec } = createSession();
  const res = NextResponse.json({ ok: true });
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: maxAgeSec });
  return res;
}
