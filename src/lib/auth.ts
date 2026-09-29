import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { signingKey } from "./secrets";

export const SESSION_COOKIE = "ot_session";
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const MIN_PASSWORD_LENGTH = 8;

interface AuthRecord {
  hash: string;
  version: number;
}

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}

function checkHash(pw: string, stored: string): boolean {
  const [tag, saltHex, hashHex] = stored.split("$");
  if (tag !== "s1" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function readRecord(): AuthRecord | null {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, "_auth")).get();
  return (row?.value as AuthRecord | undefined) ?? null;
}

function writeRecord(rec: AuthRecord) {
  getDb().insert(schema.settings).values({ key: "_auth", value: rec }).onConflictDoUpdate({ target: schema.settings.key, set: { value: rec } }).run();
}

/** The stored password hash, seeded once from APP_PASSWORD. No password anywhere = null = nobody can log in. */
function authRecord(): AuthRecord | null {
  const existing = readRecord();
  if (existing) return existing;
  const initial = process.env.APP_PASSWORD;
  if (!initial) return null;
  const rec = { hash: hashPassword(initial), version: 1 };
  writeRecord(rec);
  return rec;
}

export const isConfigured = () => authRecord() !== null;

export function verifyPassword(pw: string): boolean {
  const rec = authRecord();
  return !!rec && checkHash(pw, rec.hash);
}

/** Changing the password bumps the version, which invalidates every existing session. */
export function setPassword(pw: string) {
  const rec = authRecord();
  writeRecord({ hash: hashPassword(pw), version: (rec?.version ?? 0) + 1 });
}

const sign = (payload: string) => crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");

export function createSession(): { token: string; maxAgeSec: number } {
  const rec = authRecord();
  if (!rec) throw new Error("No password configured");
  const payload = `${rec.version}.${Date.now() + SESSION_TTL_MS}`;
  return { token: `${payload}.${sign(payload)}`, maxAgeSec: SESSION_TTL_MS / 1000 };
}

export function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  const [version, exp, sig] = token.split(".");
  if (!version || !exp || !sig) return false;
  const expected = Buffer.from(sign(`${version}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  if (Number(exp) < Date.now()) return false;
  return authRecord()?.version === Number(version);
}

// Login throttling: 5 wrong passwords from one address locks it out for a minute.
const attempts = new Map<string, { n: number; until: number }>();

export function loginLockedFor(ip: string): number {
  const a = attempts.get(ip);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}

export function recordLogin(ip: string, ok: boolean) {
  if (ok) return void attempts.delete(ip);
  const a = attempts.get(ip) ?? { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5) {
    a.n = 0;
    a.until = Date.now() + 60_000;
  }
  attempts.set(ip, a);
}
