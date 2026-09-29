import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let cached: Buffer | null = null;

/** Master key: SECRETS_KEY env if set, otherwise a random key generated once next to the database (never committed). */
function masterKey(): Buffer {
  if (cached) return cached;
  if (process.env.SECRETS_KEY) {
    cached = crypto.createHash("sha256").update(process.env.SECRETS_KEY).digest();
    return cached;
  }
  if (process.env.VERCEL || process.env.TURSO_DATABASE_URL || process.env.STORAGE_TURSO_DATABASE_URL) throw new Error("SECRETS_KEY is not set. It is required whenever the app uses a hosted database.");
  const dbFile = path.resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH ?? "./data/trader.db");
  const keyFile = path.join(path.dirname(dbFile), ".secret-key");
  if (fs.existsSync(keyFile)) {
    cached = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  } else {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    cached = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, cached.toString("hex"), { mode: 0o600 });
  }
  return cached;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(blob: string): string | null {
  try {
    const [v, iv, tag, data] = blob.split(".");
    if (v !== "v1") return null;
    const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Separate derived key for signing session cookies. */
export function signingKey(): Buffer {
  return crypto.createHmac("sha256", masterKey()).update("session-signing").digest();
}
