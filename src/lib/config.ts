import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { decrypt, encrypt } from "./secrets";
import { QuantTuningSchema } from "./quant/tuning";

/** Operational knobs: how often background chores run, how long history is kept, how loud to log. */
export const OpsSchema = z.object({
  logRetentionDays: z.number().int().min(1).max(365).default(14),
  jobRetentionDays: z.number().int().min(1).max(365).default(14),
  equityRetentionDays: z.number().int().min(7).max(3650).default(730),
  equitySnapshotMinutes: z.number().int().min(5).max(360).default(15),
  outcomesIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  learningIntervalHours: z.number().int().min(1).max(72).default(6),
  backfillIntervalMinutes: z.number().int().min(1).max(240).default(3),
  /** The worker counts as down when its last heartbeat is older than this. */
  workerStaleMinutes: z.number().int().min(2).max(60).default(4),
  /** A background job taking longer than this is logged as a warning. */
  slowJobSeconds: z.number().int().min(10).max(280).default(150),
  /** Also write a line to the log for every successful background job, not only failures and slow ones. */
  verboseLogging: z.boolean().default(false),
  /** Maximum acceptable age of the Yahoo execution quote. */
  maxUsQuoteAgeSeconds: z.number().int().min(30).max(3600).default(900),
  maxUkQuoteAgeSeconds: z.number().int().min(60).max(3600).default(1200),
  /** Emit a critical alert when an actual fill is this far from the reference quote. */
  maxSlippagePct: z.number().min(0.05).max(10).default(1),
});
export type OpsSettings = z.infer<typeof OpsSchema>;

export const IntradaySchema = z.object({
  /** Signal generation is enabled by default, but orders require the separate switch below. */
  enabled: z.boolean().default(true),
  ordersEnabled: z.boolean().default(false),
  approvalMode: z.boolean().default(true),
  usEnabled: z.boolean().default(true),
  ukEnabled: z.boolean().default(false),
  scanIntervalMinutes: z.number().int().min(1).max(30).default(5),
  maxTradesPerDay: z.number().int().min(1).max(10).default(2),
  cooldownMinutes: z.number().int().min(5).max(240).default(30),
  entryStartMinutesAfterOpen: z.number().int().min(15).max(180).default(35),
  entryCutoffMinutesBeforeClose: z.number().int().min(30).max(240).default(75),
  maxHoldMinutes: z.number().int().min(10).max(240).default(90),
  positionPct: z.number().min(0.01).max(0.5).default(0.1),
  stopLossPct: z.number().min(0.2).max(10).default(0.8),
  takeProfitPct: z.number().min(0.2).max(20).default(1.4),
  trailingStopPct: z.number().min(0.1).max(10).default(0.6),
  minMomentumPct: z.number().min(0.01).max(10).default(0.15),
  maxMomentumPct: z.number().min(0.1).max(20).default(2.5),
  minRelativeVolume: z.number().min(0.1).max(10).default(1.1),
  minScore: z.number().int().min(40).max(95).default(65),
  minConfidence: z.number().min(0.5).max(0.95).default(0.6),
  minExpectedEdgePct: z.number().min(0).max(5).default(0.15),
  maxSpreadPct: z.number().min(0.01).max(5).default(0.35),
  minBars: z.number().int().min(12).max(60).default(24),
  usWatchlist: z.array(z.string().trim().min(1).max(20)).min(1).max(30).default(["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL"]),
  ukWatchlist: z.array(z.string().trim().min(1).max(20)).min(1).max(30).default(["AZN.L", "BP.L", "HSBA.L", "SHEL.L", "ULVR.L"]),
});
export type IntradaySettings = z.infer<typeof IntradaySchema>;

/** User-tunable settings, persisted in SQLite. Hard limits live here but are enforced in lib/risk. */
export const SettingsSchema = z.object({
  // "dry" = the full pipeline runs and results are simulated, no orders sent. "trading" = send orders to T212_ENV.
  tradingEnabled: z.boolean().default(false),
  // Must be set through the typed-confirmation flow before T212_ENV=live is allowed to send orders.
  liveConfirmed: z.boolean().default(false),
  killSwitch: z.boolean().default(false),
  approvalMode: z.boolean().default(true),
  overnightEnabled: z.boolean().default(true),
  /** Demo mode only: if the engine passes, still buy its best-ranked name so the outcome can be learned from. */
  demoForceTrade: z.boolean().default(true),
  /** Share of the account staked on a demo exploration trade. */
  demoForceInvestPct: z.number().min(0.01).max(0.5).default(0.1),
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
  /** Everything adjustable inside the quantitative engine. */
  quant: QuantTuningSchema.default(QuantTuningSchema.parse({})),
  /** Low-frequency intraday strategy, designed for a durable one-minute serverless tick. */
  intraday: IntradaySchema.default(IntradaySchema.parse({})),
  /** Housekeeping, retention and diagnostics. None of this changes what the engine decides. */
  ops: OpsSchema.default(OpsSchema.parse({})),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Every field above carries a `.default()`, and `.partial()` only makes a key *optional* - the
 * default still fires when the key is absent. Parsing a one-key patch with it therefore returns a
 * fully populated object, and `updateSettings` would write all of those defaults back, so changing
 * one toggle silently reset every other setting. Strip the defaults instead, recursively, so a
 * patch parses to exactly the keys it was given while still being type-checked.
 */
function stripDefaults(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodDefault) return stripDefaults(schema.def.innerType as z.ZodType);
  if (schema instanceof z.ZodOptional) return stripDefaults(schema.def.innerType as z.ZodType).optional();
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, stripDefaults(v as z.ZodType).optional()]));
    return z.object(shape);
  }
  return schema;
}

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] };
export const SettingsPatchSchema = stripDefaults(SettingsSchema) as z.ZodType<SettingsPatch>;

/** The engine's tuning, read straight from settings. */
export async function getTuning() {
  return (await getSettings()).quant;
}

export async function getSettings(): Promise<Settings> {
  const db = getDb();
  const rows = await db.select().from(schema.settings);
  const obj: Record<string, unknown> = {};
  for (const r of rows) obj[r.key] = r.value;
  return SettingsSchema.parse(obj);
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const db = getDb();
  const current = await getSettings();
  // The nested objects have a default for every field, so a shallow spread would silently reset
  // any key the caller left out of a partial patch. Merge them a level deeper.
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (patch.quant) merged.quant = { ...current.quant, ...patch.quant };
  if (patch.intraday) merged.intraday = { ...current.intraday, ...patch.intraday };
  if (patch.ops) merged.ops = { ...current.ops, ...patch.ops };
  if (patch.markets) merged.markets = { ...current.markets, ...patch.markets };
  const next = SettingsSchema.parse(merged);
  for (const [key, value] of Object.entries(next)) {
    await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  }
  return next;
}

interface StoredConn {
  t212Env?: "demo" | "live";
  t212Key?: string;
  t212Secret?: string;
}

export async function readConnection(): Promise<StoredConn> {
  const [row] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "_conn"));
  return (row?.value as StoredConn | undefined) ?? {};
}

export interface ConnectionPatch {
  t212Env?: "demo" | "live";
  t212Key?: string;
  t212Secret?: string;
}

export async function writeConnection(patch: ConnectionPatch) {
  const cur = await readConnection();
  const next: StoredConn = { ...cur };
  if (patch.t212Env) next.t212Env = patch.t212Env;
  if (patch.t212Key) next.t212Key = encrypt(patch.t212Key);
  if (patch.t212Secret) next.t212Secret = encrypt(patch.t212Secret);
  await getDb().insert(schema.settings).values({ key: "_conn", value: next }).onConflictDoUpdate({ target: schema.settings.key, set: { value: next } });
}

/** Keys saved in Settings win over environment variables. */
export async function getEnvConfig() {
  const c = await readConnection();
  const dec = (v: string | undefined) => (v ? decrypt(v) : null);
  const envName = c.t212Env ?? (process.env.T212_ENV === "live" ? "live" : "demo");

  return {
    t212Env: envName as "demo" | "live",
    t212Key: dec(c.t212Key) ?? process.env.T212_API_KEY ?? "",
    t212Secret: dec(c.t212Secret) ?? process.env.T212_API_SECRET ?? "",
  };
}

/** Run mode is frozen at run creation so a settings change mid-run can never upgrade a dry run to real orders. */
export async function currentMode(s?: Settings): Promise<"dry" | "demo" | "live"> {
  s ??= await getSettings();
  if (!s.tradingEnabled) return "dry";
  const env = (await getEnvConfig()).t212Env;
  if (env === "live" && !s.liveConfirmed) return "dry";
  return env;
}
