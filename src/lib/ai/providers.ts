// Client-safe registry of supported AI providers (no server imports).
export const PROVIDER_IDS = ["openai", "gemini", "anthropic"] as const;
export type Provider = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: Provider;
  label: string;
  defaultModel: string;
  models: string[];
  keyPlaceholder: string;
  envKey: string;
  keyUrl: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5", "gpt-5-mini", "gpt-4.1"],
    keyPlaceholder: "API key (sk-…)",
    envKey: "OPENAI_API_KEY",
    keyUrl: "platform.openai.com/api-keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    keyPlaceholder: "API key (AIza…)",
    envKey: "GEMINI_API_KEY",
    keyUrl: "aistudio.google.com/apikey",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
    keyPlaceholder: "API key (sk-ant-…)",
    envKey: "ANTHROPIC_API_KEY",
    keyUrl: "console.anthropic.com/settings/keys",
  },
};

export const isProvider = (v: unknown): v is Provider => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
