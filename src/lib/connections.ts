import { getEnvConfig, readConnection } from "./config";
import { T212Client } from "./t212/client";
import { FmpClient } from "./market/fmp";

export interface TestResult {
  ok: boolean;
  detail: string;
}

export async function testT212(env: "demo" | "live", key: string, secret: string): Promise<TestResult> {
  if (!key || !secret) return { ok: false, detail: "Trading 212 API key and secret are both required." };
  try {
    const s = await new T212Client(env, key, secret).getAccountSummary();
    return { ok: true, detail: `Connected to your ${env} account. Total value ${s.totalValue.toFixed(2)} ${s.currency}.` };
  } catch (err) {
    return {
      ok: false,
      detail: `Trading 212 rejected the connection (${env}): ${String(err).slice(0, 200)}. Demo keys only work with "demo", live keys with "live".`,
    };
  }
}

export async function testFmp(key: string): Promise<TestResult> {
  if (!key) return { ok: false, detail: "Financial Modeling Prep API key is required." };
  try {
    const quote = await new FmpClient(key).quote("AAPL");
    if (!quote) return { ok: false, detail: "FMP authenticated but returned no AAPL quote." };
    return { ok: true, detail: `Connected to FMP Starter. AAPL quote ${quote.price.toFixed(2)} received.` };
  } catch (error) {
    return { ok: false, detail: `FMP rejected the connection: ${String(error).slice(0, 220)}` };
  }
}

/** Never includes the secrets themselves, only whether they exist and where they come from. */
export async function connectionStatus() {
  const e = await getEnvConfig();
  const stored = await readConnection();
  return {
    t212Env: e.t212Env,
    hasT212Keys: !!(e.t212Key && e.t212Secret),
    t212Source: stored.t212Key ? "settings" : e.t212Key ? "environment" : null,
    t212KeyHint: e.t212Key ? `…${e.t212Key.slice(-4)}` : null,
    hasFmpKey: !!e.fmpKey,
    fmpSource: stored.fmpKey ? "settings" : e.fmpKey ? "environment" : null,
    fmpKeyHint: e.fmpKey ? `…${e.fmpKey.slice(-4)}` : null,
  };
}
