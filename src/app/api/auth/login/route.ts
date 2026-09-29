import { NextResponse } from "next/server";
import { SESSION_COOKIE, createSession, isConfigured, loginLockedFor, recordLogin, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isConfigured())) return NextResponse.json({ error: "No password is configured. Set APP_PASSWORD in the environment." }, { status: 503 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const wait = loginLockedFor(ip);
  if (wait > 0) return NextResponse.json({ error: `Too many attempts. Try again in ${wait}s.` }, { status: 429 });

  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const ok = typeof body?.password === "string" && (await verifyPassword(body.password));
  recordLogin(ip, ok);
  if (!ok) return NextResponse.json({ error: "Wrong password" }, { status: 401 });

  const { token, maxAgeSec } = await createSession();
  const res = NextResponse.json({ ok: true });
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: https, path: "/", maxAge: maxAgeSec });
  return res;
}
