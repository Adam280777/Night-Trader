import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { getEnvConfig } from "../config";

let client: { key: string; api: OpenAI } | null = null;
async function openai() {
  const { openaiKey } = await getEnvConfig();
  if (!openaiKey) throw new Error("OpenAI API key not set (add it in Settings)");
  if (client?.key !== openaiKey) client = { key: openaiKey, api: new OpenAI({ apiKey: openaiKey, timeout: 15 * 60_000, maxRetries: 2 }) };
  return client.api;
}

export interface StructuredOpts {
  name: string;
  instructions: string;
  input: string;
  webSearch?: boolean;
  effort?: "low" | "medium" | "high";
}

export interface StructuredResult<T> {
  data: T;
  /** Every URL the model actually opened/cited, for showing sources in the UI. */
  citations: { title: string; url: string }[];
}

/** One Responses API call returning a zod-validated object, optionally with live web search. */
export async function structured<S extends z.ZodType>(schema: S, o: StructuredOpts): Promise<StructuredResult<z.infer<S>>> {
  const { openaiModel } = await getEnvConfig();
  const reasoning = /^(gpt-5|o\d)/.test(openaiModel) ? { effort: o.effort ?? "medium" } : undefined;

  const res = await (await openai()).responses.parse({
    model: openaiModel,
    instructions: o.instructions,
    input: o.input,
    ...(reasoning ? { reasoning } : {}),
    ...(o.webSearch ? { tools: [{ type: "web_search" as const }] } : {}),
    text: { format: zodTextFormat(schema, o.name) },
  });

  if (!res.output_parsed) throw new Error(`Model returned no parseable output for ${o.name} (status: ${res.status})`);

  const seen = new Set<string>();
  const citations: { title: string; url: string }[] = [];
  for (const item of res.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type !== "output_text") continue;
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && !seen.has(a.url)) {
          seen.add(a.url);
          citations.push({ title: a.title ?? a.url, url: a.url });
        }
      }
    }
  }
  return { data: res.output_parsed as z.infer<S>, citations };
}

/** Plain streaming-free text answer, used by the chat panel. */
export async function chatText(instructions: string, input: string): Promise<string> {
  const { openaiModel } = await getEnvConfig();
  const res = await (await openai()).responses.create({
    model: openaiModel,
    instructions,
    input,
    ...(/^(gpt-5|o\d)/.test(openaiModel) ? { reasoning: { effort: "low" as const } } : {}),
  });
  return res.output_text;
}
