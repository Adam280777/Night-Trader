import { getEnvConfig, readConnection } from "./config";
import { T212Client } from "./t212/client";

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
    return { ok: false, detail: `Trading 212 rejected the connection (${env}): ${String(err).slice(0, 200)}. Demo keys only work with "demo", live keys with "live".` };
  }
}

export async function testOpenAI(key: string, model: string): Promise<TestResult> {
  if (!key) return { ok: false, detail: "OpenAI API key is required." };
  try {
    const r = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return { ok: true, detail: `Key accepted and model "${model}" is available.` };
    if (r.status === 401) return { ok: false, detail: "OpenAI rejected this key (401)." };
    if (r.status === 404) return { ok: false, detail: `Key works, but model "${model}" was not found on your account.` };
    return { ok: false, detail: `OpenAI returned HTTP ${r.status}.` };
  } catch (err) {
    return { ok: false, detail: `Could not reach OpenAI: ${String(err).slice(0, 150)}` };
  }
}

/** Never includes the secrets themselves, only whether they exist and where they come from. */
export function connectionStatus() {
  const e = getEnvConfig();
  const stored = readConnection();
  return {
    t212Env: e.t212Env,
    hasT212Keys: !!(e.t212Key && e.t212Secret),
    t212Source: stored.t212Key ? "settings" : e.t212Key ? "environment" : null,
    t212KeyHint: e.t212Key ? `…${e.t212Key.slice(-4)}` : null,
    hasOpenAI: !!e.openaiKey,
    openaiSource: stored.openaiKey ? "settings" : e.openaiKey ? "environment" : null,
    openaiKeyHint: e.openaiKey ? `…${e.openaiKey.slice(-4)}` : null,
    openaiModel: e.openaiModel,
  };
}
