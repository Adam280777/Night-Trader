import { getEnvConfig, readConnection } from "./config";
import { T212Client } from "./t212/client";
import { PROVIDERS, PROVIDER_IDS, type Provider } from "./ai/providers";

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

/** Checks the key and that the model exists, using each provider's free "get model" endpoint. */
export async function testAI(provider: Provider, key: string, model: string): Promise<TestResult> {
  const label = PROVIDERS[provider].label;
  if (!key) return { ok: false, detail: `${label} API key is required.` };
  const m = encodeURIComponent(model);
  const [url, headers]: [string, Record<string, string>] =
    provider === "openai"
      ? [`https://api.openai.com/v1/models/${m}`, { Authorization: `Bearer ${key}` }]
      : provider === "gemini"
        ? [`https://generativelanguage.googleapis.com/v1beta/models/${m}`, { "x-goog-api-key": key }]
        : [`https://api.anthropic.com/v1/models/${m}`, { "x-api-key": key, "anthropic-version": "2023-06-01" }];
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (r.ok) return { ok: true, detail: `${label} key accepted and model "${model}" is available.` };
    if (r.status === 404) return { ok: false, detail: `Key works, but model "${model}" was not found for ${label}. Pick another model.` };
    if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, detail: `${label} rejected this key (HTTP ${r.status}).` };
    return { ok: false, detail: `${label} returned HTTP ${r.status}.` };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${label}: ${String(err).slice(0, 150)}` };
  }
}

/** Never includes the secrets themselves, only whether they exist and where they come from. */
export async function connectionStatus() {
  const e = await getEnvConfig();
  const stored = await readConnection();
  const providers = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, { has: !!e.providers[id].key, source: e.providers[id].source, keyHint: e.providers[id].key ? `…${e.providers[id].key.slice(-4)}` : null, model: e.providers[id].model }]),
  ) as Record<Provider, { has: boolean; source: "settings" | "environment" | null; keyHint: string | null; model: string }>;
  return {
    t212Env: e.t212Env,
    hasT212Keys: !!(e.t212Key && e.t212Secret),
    t212Source: stored.t212Key ? "settings" : e.t212Key ? "environment" : null,
    t212KeyHint: e.t212Key ? `…${e.t212Key.slice(-4)}` : null,
    aiProvider: e.aiProvider,
    providers,
  };
}
