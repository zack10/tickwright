import { Prisma } from "@prisma/client";
import { encrypt } from "./crypto";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Applies `change` to config.reviewer and every config.models entry (each can carry its own key). */
const eachCallModel = (config: JsonRecord, change: (entry: JsonRecord) => JsonRecord) => {
  if (isRecord(config.reviewer)) config.reviewer = change(config.reviewer);
  if (isRecord(config.models))
    config.models = Object.fromEntries(
      Object.entries(config.models).map(([name, entry]) => [name, isRecord(entry) ? change(entry) : entry]),
    );
};

export const protectAgentConfig = (
  value: unknown,
): Prisma.InputJsonObject | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const config = { ...(value as JsonRecord) };
  if (typeof config.apiKey === "string" && config.apiKey.length > 0) {
    config.apiKey = encrypt(config.apiKey);
  }
  eachCallModel(config, (entry) =>
    typeof entry.apiKey === "string" && entry.apiKey.length > 0 ? { ...entry, apiKey: encrypt(entry.apiKey) } : entry,
  );
  return config as Prisma.InputJsonObject;
};

export const redactAgent = <T extends { config?: unknown }>(
  agent: T,
): Omit<T, "config"> & { config?: JsonRecord } => {
  const { config, ...safe } = agent;
  if (!config || typeof config !== "object" || Array.isArray(config))
    return safe;
  const publicConfig = { ...(config as JsonRecord) };
  delete publicConfig.apiKey;
  eachCallModel(publicConfig, ({ apiKey: _apiKey, ...entry }) => entry);
  return { ...safe, config: publicConfig };
};
