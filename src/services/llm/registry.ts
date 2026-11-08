import { z } from "zod";
import { config } from "../../config";
import { AnthropicProvider } from "./providers/AnthropicProvider";
import { GeminiProvider } from "./providers/GeminiProvider";
import {
  OpenAICompatibleProfile,
  OpenAICompatibleProvider,
} from "./providers/OpenAICompatibleProvider";
import { LLMProvider } from "./types";

/** Providers with their own API format; everything else is OpenAI-compatible. */
const NATIVE_KEYS = ["gemini", "anthropic"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const profileSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,31}$/, "key must be 2-32 lowercase letters, digits or dashes"),
    label: z.string().min(1).max(60).optional(),
    baseUrl: z.string().url(),
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

const TOOLS_APIS = ["chat", "responses"] as const;

export type ProviderProfileInput = z.input<typeof profileSchema>;

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
 * Parses LLM_PROVIDERS (a JSON array of OpenAI-compatible profiles) and fails
 * loudly on anything wrong, so a typo stops the server at boot instead of
 * failing on the first ticket.
 */
export const parseProviderProfiles = (
  raw: string | undefined,
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): OpenAICompatibleProfile[] => {
  // OpenAI's newest models reject tools with reasoning on chat completions (roadmap limitation 24).
  const openaiToolsApi = env.OPENAI_TOOLS_API?.trim() || "responses";
  if (!TOOLS_APIS.includes(openaiToolsApi as (typeof TOOLS_APIS)[number]))
    throw new Error(`OPENAI_TOOLS_API must be "chat" or "responses", got "${openaiToolsApi}"`);
  const builtIn: OpenAICompatibleProfile = {
    key: "openai",
    label: "OpenAI",
    baseUrl: checkBaseUrl("openai", env.OPENAI_BASE_URL || "https://api.openai.com/v1", nodeEnv),
    apiKey: env.OPENAI_API_KEY ?? "",
    supportsTools: true,
    modelPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-"],
    toolsApi: openaiToolsApi as OpenAICompatibleProfile["toolsApi"],
  };
  if (!raw?.trim()) return [builtIn];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("LLM_PROVIDERS must be a JSON array of provider profiles");
  }
  const parsed = z.array(profileSchema).safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`LLM_PROVIDERS is invalid at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }

  const seen = new Set<string>([...NATIVE_KEYS, builtIn.key]);
  return [
    builtIn,
    ...parsed.data.map((profile) => {
      if (seen.has(profile.key))
        throw new Error(`LLM_PROVIDERS: provider key "${profile.key}" is already in use`);
      seen.add(profile.key);
      if (profile.apiKeyEnv && !env[profile.apiKeyEnv])
        throw new Error(`LLM provider "${profile.key}": environment variable ${profile.apiKeyEnv} is not set`);
      return {
        key: profile.key,
        label: profile.label ?? profile.key,
        baseUrl: checkBaseUrl(profile.key, profile.baseUrl, nodeEnv),
        apiKey: profile.apiKeyEnv ? (env[profile.apiKeyEnv] ?? "") : "",
        supportsTools: profile.supportsTools,
        modelPrefixes: profile.modelPrefixes,
        toolsApi: profile.toolsApi,
      };
    }),
  ];
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
    profiles: OpenAICompatibleProfile[],
    readonly defaultProvider: string,
    readonly defaultModel: string,
  ) {
    this.providers.set("gemini", {
      provider: new GeminiProvider(),
      info: { key: "gemini", label: "Gemini", kind: "native", supportsTools: true },
    });
    this.providers.set("anthropic", {
      provider: new AnthropicProvider(),
      info: { key: "anthropic", label: "Anthropic", kind: "native", supportsTools: true },
    });
    for (const profile of profiles) {
      this.providers.set(profile.key, {
        provider: new OpenAICompatibleProvider(profile),
        info: {
          key: profile.key,
          label: profile.label,
          kind: "openai-compatible",
          supportsTools: profile.supportsTools,
        },
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
