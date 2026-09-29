import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { ensureMigrated, getDb, schema } from "./db";
import { signingKey } from "./secrets";

export const SESSION_COOKIE = "ot_session";
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const MIN_PASSWORD_LENGTH = 8;

interface AuthRecord {
  hash: string;
  version: number;
  custom?: boolean; // set once the password is changed in Settings; from then on APP_PASSWORD is ignored
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

async function readRecord(): Promise<AuthRecord | null> {
  await ensureMigrated();
  const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "_auth"));
  return (row?.value as AuthRecord | undefined) ?? null;
}

async function writeRecord(rec: AuthRecord) {
  await getDb().insert(schema.settings).values({ key: "_auth", value: rec }).onConflictDoUpdate({ target: schema.settings.key, set: { value: rec } });
}

let envChecked: string | undefined;

/**
 * The stored password hash. Until the password is changed in Settings, APP_PASSWORD is the source of truth
 * (editing it in Vercel and redeploying takes effect). No password anywhere = null = nobody can log in.
 */
async function authRecord(): Promise<AuthRecord | null> {
  const existing = await readRecord();
  const env = process.env.APP_PASSWORD?.trim();
  if (existing?.custom || !env) return existing;
  if (existing && envChecked === env) return existing;
  if (existing && checkHash(env, existing.hash)) {
    envChecked = env;
    return existing;
  }
  const rec = { hash: hashPassword(env), version: (existing?.version ?? 0) + 1 };
  await writeRecord(rec);
  envChecked = env;
  return rec;
}

export const isConfigured = async () => (await authRecord()) !== null;

export async function verifyPassword(pw: string): Promise<boolean> {
  const rec = await authRecord();
  return !!rec && checkHash(pw, rec.hash);
}

/** Changing the password bumps the version, which invalidates every existing session. */
export async function setPassword(pw: string) {
  const rec = await authRecord();
  await writeRecord({ hash: hashPassword(pw), version: (rec?.version ?? 0) + 1, custom: true });
}

const sign = (payload: string) => crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");

export async function createSession(): Promise<{ token: string; maxAgeSec: number }> {
  const rec = await authRecord();
  if (!rec) throw new Error("No password configured");
  const payload = `${rec.version}.${Date.now() + SESSION_TTL_MS}`;
  return { token: `${payload}.${sign(payload)}`, maxAgeSec: SESSION_TTL_MS / 1000 };
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [version, exp, sig] = token.split(".");
  if (!version || !exp || !sig) return false;
  const expected = Buffer.from(sign(`${version}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
  if (Number(exp) < Date.now()) return false;
  return (await authRecord())?.version === Number(version);
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
