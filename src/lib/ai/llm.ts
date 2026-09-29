import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { getEnvConfig } from "../config";
import { PROVIDERS, type Provider } from "./providers";

export interface StructuredOpts {
  name: string;
  instructions: string;
  input: string;
  webSearch?: boolean;
  effort?: "low" | "medium" | "high";
}

type Citation = { title: string; url: string };

export interface StructuredResult<T> {
  data: T;
  /** Every URL the model actually opened/cited, for showing sources in the UI. */
  citations: Citation[];
}

interface Active {
  provider: Provider;
  key: string;
  model: string;
}

async function active(): Promise<Active> {
  const { ai } = await getEnvConfig();
  if (!ai.key) throw new Error(`${PROVIDERS[ai.provider].label} API key not set (add it in Settings)`);
  return ai;
}

const dedupe = (list: Citation[]) => [...new Map(list.filter((c) => c.url).map((c) => [c.url, c])).values()];

// ---------- OpenAI (Responses API, native structured output) ----------

let oaClient: { key: string; api: OpenAI } | null = null;
function openai(key: string) {
  if (oaClient?.key !== key) oaClient = { key, api: new OpenAI({ apiKey: key, timeout: 15 * 60_000, maxRetries: 2 }) };
  return oaClient.api;
}
const isReasoning = (model: string) => /^(gpt-5|o\d)/.test(model);

async function openaiStructured<S extends z.ZodType>(a: Active, schema: S, o: StructuredOpts): Promise<StructuredResult<z.infer<S>>> {
  const res = await openai(a.key).responses.parse({
    model: a.model,
    instructions: o.instructions,
    input: o.input,
    ...(isReasoning(a.model) ? { reasoning: { effort: o.effort ?? "medium" } } : {}),
    ...(o.webSearch ? { tools: [{ type: "web_search" as const }] } : {}),
    text: { format: zodTextFormat(schema, o.name) },
  });
  if (!res.output_parsed) throw new Error(`Model returned no parseable output for ${o.name} (status: ${res.status})`);
  const citations: Citation[] = [];
  for (const item of res.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type !== "output_text") continue;
      for (const an of part.annotations ?? []) if (an.type === "url_citation") citations.push({ title: an.title ?? an.url, url: an.url });
    }
  }
  return { data: res.output_parsed as z.infer<S>, citations: dedupe(citations) };
}

// ---------- Gemini and Claude (REST; JSON enforced through the prompt and validated with zod) ----------

interface RawReply {
  text: string;
  citations: Citation[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(url: string, headers: Record<string, string>, body: unknown, label: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${JSON.stringify(json?.error?.message ?? json?.error ?? json).slice(0, 300)}`);
  return json;
}

async function geminiCall(a: Active, system: string, input: string, webSearch: boolean, json: boolean): Promise<RawReply> {
  const j = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model)}:generateContent`,
    { "x-goog-api-key": a.key },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: input }] }],
      ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
      // JSON mode cannot be combined with the search tool, so with search the JSON comes from the prompt.
      ...(json && !webSearch ? { generationConfig: { responseMimeType: "application/json" } } : {}),
    },
    "Gemini",
  );
  const cand = j?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  if (!text) throw new Error(`Gemini returned no text (finish reason: ${cand?.finishReason ?? j?.promptFeedback?.blockReason ?? "unknown"})`);
  const chunks: { web?: { uri?: string; title?: string } }[] = cand?.groundingMetadata?.groundingChunks ?? [];
  return { text, citations: chunks.filter((c) => c.web?.uri).map((c) => ({ title: c.web!.title ?? c.web!.uri!, url: c.web!.uri! })) };
}

async function claudeCall(a: Active, system: string, input: string, webSearch: boolean): Promise<RawReply> {
  const j = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": a.key, "anthropic-version": "2023-06-01" },
    {
      model: a.model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: input }],
      ...(webSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }] } : {}),
    },
    "Claude",
  );
  const blocks: { type: string; text?: string; citations?: { url?: string; title?: string }[] }[] = j?.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (!text) throw new Error(`Claude returned no text (stop reason: ${j?.stop_reason ?? "unknown"})`);
  const citations = blocks.flatMap((b) => (b.citations ?? []).filter((c) => c.url).map((c) => ({ title: c.title ?? c.url!, url: c.url! })));
  return { text, citations };
}

function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found in the reply");
  return JSON.parse(t.slice(start, end + 1));
}

async function jsonStructured<S extends z.ZodType>(a: Active, schema: S, o: StructuredOpts): Promise<StructuredResult<z.infer<S>>> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const system = `${o.instructions}\n\nOutput format: reply with ONLY one JSON object (no prose, no markdown fences) that validates against this JSON Schema:\n${jsonSchema}`;
  const call = (input: string) => (a.provider === "gemini" ? geminiCall(a, system, input, !!o.webSearch, true) : claudeCall(a, system, input, !!o.webSearch));

  let reply = await call(o.input);
  const citations = [...reply.citations];
  for (let attempt = 0; ; attempt++) {
    try {
      return { data: schema.parse(extractJson(reply.text)), citations: dedupe(citations) };
    } catch (err) {
      if (attempt >= 1) throw new Error(`Model output for ${o.name} did not match the schema: ${String(err).slice(0, 250)}`);
      reply = await call(`${o.input}\n\nYour previous reply was not valid (${String(err).slice(0, 200)}). Reply again with ONLY the JSON object.`);
      citations.push(...reply.citations);
    }
  }
}

// ---------- Public API ----------

/** One call returning a schema-validated object, optionally with live web search. */
export async function structured<S extends z.ZodType>(schema: S, o: StructuredOpts): Promise<StructuredResult<z.infer<S>>> {
  const a = await active();
  return a.provider === "openai" ? openaiStructured(a, schema, o) : jsonStructured(a, schema, o);
}

/** Plain text answer, used by the chat panel. */
export async function chatText(instructions: string, input: string, opts: { webSearch?: boolean } = {}): Promise<string> {
  const a = await active();
  const webSearch = !!opts.webSearch;
  if (a.provider === "gemini") return (await geminiCall(a, instructions, input, webSearch, false)).text;
  if (a.provider === "anthropic") return (await claudeCall(a, instructions, input, webSearch)).text;
  const res = await openai(a.key).responses.create({
    model: a.model,
    instructions,
    input,
    ...(isReasoning(a.model) ? { reasoning: { effort: "low" as const } } : {}),
    ...(webSearch ? { tools: [{ type: "web_search" as const }] } : {}),
  });
  return res.output_text;
}
