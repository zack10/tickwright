import { z } from "zod";
import { config } from "../../config";
import { AnthropicProvider } from "./providers/AnthropicProvider";
import { GeminiProvider } from "./providers/GeminiProvider";
import {
  OpenAICompatibleProfile,
  OpenAICompatibleProvider,
} from "./providers/OpenAICompatibleProvider";
import { LLMProvider } from "./types";

/** API formats with their own adapter; every other provider speaks OpenAI's format. */
const NATIVE_TYPES = ["gemini", "anthropic"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const profileSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,31}$/, "key must be 2-32 lowercase letters, digits or dashes"),
    type: z.enum(["openai-compatible", ...NATIVE_TYPES]).default("openai-compatible"),
    label: z.string().min(1).max(60).optional(),
    // Required for openai-compatible; a native adapter knows its vendor's URL.
    baseUrl: z.string().url().optional(),
    // Name of the env var holding the key; omit for keyless local servers or
    // when every agent brings its own key.
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "apiKeyEnv must be an environment variable name")
      .optional(),
    supportsTools: z.boolean().default(false),
    // Only list models whose id starts with one of these (e.g. hide embeddings).
    modelPrefixes: z.array(z.string().min(1)).optional(),
    // Endpoint for tool calls; only OpenAI itself is known to need "responses".
    toolsApi: z.enum(["chat", "responses"]).default("chat"),
  })
  .strict();

export type ProviderProfileInput = z.input<typeof profileSchema>;

/** One provider agents can name by its key. */
export type ProviderProfile =
  | (OpenAICompatibleProfile & { type: "openai-compatible" })
  | { type: (typeof NATIVE_TYPES)[number]; key: string; label: string; apiKey: string; supportsTools: true };

/** The providers when LLM_PROVIDERS is unset; each reads its key from the variable named here, if set. */
const DEFAULT_PROVIDERS: (ProviderProfileInput & { label: string })[] = [
  { key: "gemini", type: "gemini", label: "Gemini", apiKeyEnv: "GEMINI_API_KEY" },
  { key: "anthropic", type: "anthropic", label: "Anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    supportsTools: true,
    modelPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-"],
    // OpenAI's newest models reject tools with reasoning on chat completions (roadmap limitation 24).
    toolsApi: "responses",
  },
];

/**
 * Checks a profile's base URL. Base URLs only ever come from server
 * configuration: an agent picks a provider key, never a host, so it cannot
 * make the server send a key somewhere else.
 */
const checkBaseUrl = (key: string, raw: string, nodeEnv: string): string => {
  const url = new URL(raw);
  if (url.username || url.password)
    throw new Error(`LLM provider "${key}": baseUrl must not contain credentials`);
  if (url.search || url.hash)
    throw new Error(`LLM provider "${key}": baseUrl must not contain a query or fragment`);
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname))
      throw new Error(`LLM provider "${key}": baseUrl must use https (http is only allowed for localhost)`);
    if (nodeEnv === "production")
      throw new Error(`LLM provider "${key}": http baseUrl is not allowed in production`);
  } else if (url.protocol !== "https:") {
    throw new Error(`LLM provider "${key}": baseUrl must use https`);
  }
  return url.toString().replace(/\/$/, "");
};

/**
 * Parses LLM_PROVIDERS, the one list of every provider agents can use
 * (OpenAI, Gemini and Anthropic when it is unset), and fails loudly on
 * anything wrong, so a typo stops the server at boot instead of failing on
 * the first ticket.
 */
export const parseProviderProfiles = (
  raw: string | undefined,
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): ProviderProfile[] => {
  const listed = !!raw?.trim();
  let entries: ProviderProfileInput[] = DEFAULT_PROVIDERS;
  if (listed) {
    let json: unknown;
    try {
      json = JSON.parse(raw as string);
    } catch {
      throw new Error("LLM_PROVIDERS must be a JSON array of provider profiles");
    }
    entries = json as ProviderProfileInput[];
  }
  const parsed = z.array(profileSchema).safeParse(entries);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`LLM_PROVIDERS is invalid at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }

  const seen = new Set<string>();
  return parsed.data.map((profile): ProviderProfile => {
    if (seen.has(profile.key))
      throw new Error(`LLM_PROVIDERS: provider key "${profile.key}" is already in use`);
    seen.add(profile.key);
    // A listed variable must exist, so a typo fails at boot; the defaults run without keys (agents bring their own).
    if (listed && profile.apiKeyEnv && !env[profile.apiKeyEnv])
      throw new Error(`LLM provider "${profile.key}": environment variable ${profile.apiKeyEnv} is not set`);
    const label = profile.label ?? profile.key;
    const apiKey = profile.apiKeyEnv ? (env[profile.apiKeyEnv] ?? "") : "";
    if (profile.type !== "openai-compatible") {
      if (profile.baseUrl || profile.modelPrefixes || profile.toolsApi !== "chat")
        throw new Error(`LLM provider "${profile.key}": a ${profile.type} provider takes only key, type, label and apiKeyEnv`);
      // Native adapters implement tool calls.
      return { type: profile.type, key: profile.key, label, apiKey, supportsTools: true };
    }
    if (!profile.baseUrl) throw new Error(`LLM provider "${profile.key}": baseUrl is required`);
    return {
      type: "openai-compatible",
      key: profile.key,
      label,
      baseUrl: checkBaseUrl(profile.key, profile.baseUrl, nodeEnv),
      apiKey,
      supportsTools: profile.supportsTools,
      modelPrefixes: profile.modelPrefixes,
      toolsApi: profile.toolsApi,
    };
  });
};

export interface ProviderInfo {
  key: string;
  label: string;
  kind: "native" | "openai-compatible";
  supportsTools: boolean;
}

/** Every provider the server can call, keyed by the name agents use. */
export class ProviderRegistry {
  private readonly providers = new Map<string, { provider: LLMProvider; info: ProviderInfo }>();

  constructor(
    profiles: ProviderProfile[],
    readonly defaultProvider: string,
    readonly defaultModel: string,
  ) {
    for (const profile of profiles) {
      const provider =
        profile.type === "openai-compatible"
          ? new OpenAICompatibleProvider(profile)
          : profile.type === "gemini"
            ? new GeminiProvider(profile.apiKey)
            : new AnthropicProvider(profile.apiKey);
      const kind: ProviderInfo["kind"] = profile.type === "openai-compatible" ? "openai-compatible" : "native";
      this.providers.set(profile.key, {
        provider,
        info: { key: profile.key, label: profile.label, kind, supportsTools: profile.supportsTools },
      });
    }
    if (!this.providers.has(defaultProvider))
      throw new Error(`LLM_DEFAULT_PROVIDER "${defaultProvider}" is not a configured provider`);
  }

  has(key: string): boolean {
    return this.providers.has(key);
  }

  get(key: string): LLMProvider {
    const entry = this.providers.get(key);
    if (!entry) throw new Error(`Provider ${key} not found`);
    return entry.provider;
  }

  supportsTools(key: string): boolean {
    return this.providers.get(key)?.info.supportsTools ?? false;
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((entry) => entry.info);
  }
}

let registry: ProviderRegistry | undefined;

/** The registry built from the environment; built once, on first use. */
export const getProviderRegistry = (): ProviderRegistry => {
  registry ??= new ProviderRegistry(
    parseProviderProfiles(config.llmProviders, process.env, config.nodeEnv),
    config.llmDefaultProvider,
    config.llmDefaultModel,
  );
  return registry;
};
