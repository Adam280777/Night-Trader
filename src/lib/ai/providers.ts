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
  /** Picks the default from the live model list when the saved model no longer exists. */
  preferred: RegExp;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"],
    keyPlaceholder: "API key (sk-…)",
    envKey: "OPENAI_API_KEY",
    keyUrl: "platform.openai.com/api-keys",
    preferred: /^gpt-[0-9]+(\.[0-9]+)?$/,
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-3.8-flash",
    models: ["gemini-3.8-flash"],
    keyPlaceholder: "API key (AIza…)",
    envKey: "GEMINI_API_KEY",
    keyUrl: "aistudio.google.com/apikey",
    preferred: /^gemini-[0-9.]+-flash$/,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
    keyPlaceholder: "API key (sk-ant-…)",
    envKey: "ANTHROPIC_API_KEY",
    keyUrl: "console.anthropic.com/settings/keys",
    preferred: /^claude-sonnet-[0-9.-]+$/,
  },
};

export const isProvider = (v: unknown): v is Provider => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
