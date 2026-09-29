import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { decrypt, encrypt } from "./secrets";

/** User-tunable settings, persisted in SQLite. Hard limits live here but are enforced in lib/risk. */
export const SettingsSchema = z.object({
  // "dry" = full AI pipeline, no orders sent. "trading" = send orders to the env in T212_ENV.
  tradingEnabled: z.boolean().default(false),
  // Must be set through the typed-confirmation flow before T212_ENV=live is allowed to send orders.
  liveConfirmed: z.boolean().default(false),
  killSwitch: z.boolean().default(false),
  approvalMode: z.boolean().default(true),
  markets: z.object({ US: z.boolean().default(true), UK: z.boolean().default(true) }).default({
    US: true,
    UK: true,
  }),
  maxPositionPct: z.number().min(0.01).max(1).default(0.25), // of total account value
  maxInvestPctOfCash: z.number().min(0.01).max(1).default(0.9),
  minCashReserve: z.number().min(0).default(5),
  dailyLossLimitPct: z.number().min(0.001).max(1).default(0.05),
  weeklyLossLimitPct: z.number().min(0.001).max(1).default(0.1),
  minConfidence: z.number().min(0).max(1).default(0.55),
  ukMinConfidence: z.number().min(0).max(1).default(0.7),
  minExpectedEdgePct: z.number().min(0).default(0.6), // must beat estimated round-trip costs
  minutesBeforeCloseToBuy: z.number().int().min(3).max(60).default(10),
  minutesBeforeCloseToResearch: z.number().int().min(15).max(240).default(60),
  approvalWindowMinutes: z.number().int().min(1).max(120).default(15),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function getSettings(): Settings {
  const db = getDb();
  const rows = db.select().from(schema.settings).all();
  const obj: Record<string, unknown> = {};
  for (const r of rows) obj[r.key] = r.value;
  return SettingsSchema.parse(obj);
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const db = getDb();
  const next = SettingsSchema.parse({ ...getSettings(), ...patch });
  for (const [key, value] of Object.entries(next)) {
    db.insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  }
  return next;
}

interface StoredConn {
  t212Env?: "demo" | "live";
  openaiModel?: string;
  t212Key?: string;
  t212Secret?: string;
  openaiKey?: string;
}

export function readConnection(): StoredConn {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, "_conn")).get();
  return (row?.value as StoredConn | undefined) ?? {};
}

export function writeConnection(patch: { t212Env?: "demo" | "live"; openaiModel?: string; t212Key?: string; t212Secret?: string; openaiKey?: string }) {
  const cur = readConnection();
  const next: StoredConn = { ...cur };
  if (patch.t212Env) next.t212Env = patch.t212Env;
  if (patch.openaiModel) next.openaiModel = patch.openaiModel;
  if (patch.t212Key) next.t212Key = encrypt(patch.t212Key);
  if (patch.t212Secret) next.t212Secret = encrypt(patch.t212Secret);
  if (patch.openaiKey) next.openaiKey = encrypt(patch.openaiKey);
  getDb().insert(schema.settings).values({ key: "_conn", value: next }).onConflictDoUpdate({ target: schema.settings.key, set: { value: next } }).run();
}

/** Keys saved in Settings win over environment variables. */
export function getEnvConfig() {
  const c = readConnection();
  const dec = (v: string | undefined) => (v ? decrypt(v) : null);
  const envName = c.t212Env ?? (process.env.T212_ENV === "live" ? "live" : "demo");
  return {
    t212Env: envName as "demo" | "live",
    t212Key: dec(c.t212Key) ?? process.env.T212_API_KEY ?? "",
    t212Secret: dec(c.t212Secret) ?? process.env.T212_API_SECRET ?? "",
    openaiKey: dec(c.openaiKey) ?? process.env.OPENAI_API_KEY ?? "",
    openaiModel: c.openaiModel ?? process.env.OPENAI_MODEL ?? "gpt-5.5",
  };
}

/** Run mode is frozen at run creation so a settings change mid-run can never upgrade a dry run to real orders. */
export function currentMode(s: Settings = getSettings()): "dry" | "demo" | "live" {
  if (!s.tradingEnabled) return "dry";
  const env = getEnvConfig().t212Env;
  if (env === "live" && !s.liveConfirmed) return "dry";
  return env;
}
