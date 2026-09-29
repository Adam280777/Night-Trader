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

/** Checks the key and the model. Gemini gets a tiny real generation, since a model can exist yet be closed to new users. */
export async function testAI(provider: Provider, key: string, model: string): Promise<TestResult> {
  const label = PROVIDERS[provider].label;
  if (!key) return { ok: false, detail: `${label} API key is required.` };
  const m = encodeURIComponent(model);
  let url: string;
  let init: RequestInit;
  if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
    init = {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }], generationConfig: { maxOutputTokens: 64 } }),
    };
  } else if (provider === "openai") {
    url = `https://api.openai.com/v1/models/${m}`;
    init = { headers: { Authorization: `Bearer ${key}` } };
  } else {
    url = `https://api.anthropic.com/v1/models/${m}`;
    init = { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
  }
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (r.ok) return { ok: true, detail: `${label} key accepted and model "${model}" works.` };
    const msg = String((await r.json().catch(() => null))?.error?.message ?? "").slice(0, 200);
    if (r.status === 404) return { ok: false, detail: `Model "${model}" is not available for ${label}${msg ? `: ${msg}` : ""}. Pick a model from the list.` };
    if (r.status === 429) return { ok: false, detail: `${label} says you are out of quota or rate-limited (429). ${msg}` };
    if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, detail: `${label} rejected this (HTTP ${r.status})${msg ? `: ${msg}` : ""}.` };
    return { ok: false, detail: `${label} returned HTTP ${r.status}. ${msg}` };
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

const cmp = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

/** Live list of chat-capable models for a key, newest first, plus the one we would pick by default. */
export async function listModels(provider: Provider, key: string): Promise<{ ok: boolean; detail?: string; models: string[]; suggested?: string }> {
  const label = PROVIDERS[provider].label;
  if (!key) return { ok: false, detail: `Enter or save a ${label} API key first.`, models: [] };
  const [url, headers]: [string, Record<string, string>] =
    provider === "openai"
      ? ["https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }]
      : provider === "gemini"
        ? ["https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key }]
        : ["https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key, "anthropic-version": "2023-06-01" }];
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, detail: `${label} rejected this key (HTTP ${r.status}).`, models: [] };
    let ids: string[] = [];
    if (provider === "gemini") {
      ids = (j?.models ?? [])
        .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m: { name: string }) => m.name.replace("models/", ""))
        .filter((id: string) => /^gemini-/.test(id) && !/(tts|image|embedding|live|audio|robotics|computer-use|native)/.test(id));
    } else {
      ids = (j?.data ?? []).map((m: { id: string }) => m.id);
      if (provider === "openai") ids = ids.filter((id) => /^(gpt-|o[0-9])/.test(id) && !/(embedding|tts|audio|image|realtime|transcribe|moderation|whisper|dall-e|instruct|search|codex)/.test(id));
    }
    const models = [...new Set(ids)].sort(cmp);
    if (models.length === 0) return { ok: false, detail: `${label} returned no usable models for this key.`, models: [] };
    return { ok: true, models, suggested: models.find((m) => PROVIDERS[provider].preferred.test(m)) ?? models[0] };
  } catch (err) {
    return { ok: false, detail: `Could not reach ${label}: ${String(err).slice(0, 150)}`, models: [] };
  }
}
