const parseList = (value: string | undefined): string[] =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const AGENT_MODES = ["single_shot", "tool_loop"] as const;
export type ExecutionAgentMode = (typeof AGENT_MODES)[number];

/** A typo must not silently fall back to the other mode. */
const parseAgentMode = (value: string | undefined): ExecutionAgentMode => {
  if (!value) return "tool_loop";
  if ((AGENT_MODES as readonly string[]).includes(value))
    return value as ExecutionAgentMode;
  throw new Error(
    `EXECUTION_AGENT_MODE must be one of ${AGENT_MODES.join(", ")} (got "${value}")`,
  );
};

// GitHub Codespaces' default image (built from github.com/devcontainers/images).
// Pinned to the version tested on 2026-10-31 (6.1.12, Ubuntu 24.04); update
// deliberately. 2.x (Ubuntu 20.04) shipped an apt source with an expired key,
// so no setup could install a system package.
const DEFAULT_EXECUTION_IMAGE =
  "mcr.microsoft.com/devcontainers/universal:6.1.12@sha256:7d644a3e845e78e2175c9c265a383436c93ab740e77947bbcaff9592e39f7205";

/** Like parsePositiveInt, but 0 is allowed (it switches a limit off). */
const parseNonNegativeInt = (
  value: string | undefined,
  fallback: number,
): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePositiveInt(process.env.PORT, 3001),
  apiAuthToken: process.env.API_AUTH_TOKEN ?? "",
  // Auth is only skipped when explicitly disabled outside production.
  authDisabled: process.env.AUTH_DISABLED === "true",
  apiAuthActor: process.env.API_AUTH_ACTOR ?? "api-token:default",
  artifactRoot: process.env.ARTIFACT_ROOT ?? "artifacts",
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "workspaces",
  keepWorkspaces: process.env.KEEP_WORKSPACES === "true",
  // TRELLO_POLL_INTERVAL_MS is the pre-adapter name, still honoured.
  integrationPollIntervalMs: parsePositiveInt(
    process.env.INTEGRATION_POLL_INTERVAL_MS ??
      process.env.TRELLO_POLL_INTERVAL_MS,
    30_000,
  ),
  corsOrigins: parseList(process.env.CORS_ORIGINS),
  rabbitMqUrl: process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672",
  taskMaxAttempts: parsePositiveInt(process.env.TASK_MAX_ATTEMPTS, 3),
  taskRetryDelayMs: parsePositiveInt(process.env.TASK_RETRY_DELAY_MS, 5000),
  taskLeaseMs: parsePositiveInt(process.env.TASK_LEASE_MS, 300_000),
  executionLeaseMs: parsePositiveInt(process.env.EXECUTION_LEASE_MS, 300_000),
  // Run steps (agent loop, checks, review) one server works on at once.
  executionRunConcurrency: parsePositiveInt(process.env.EXECUTION_RUN_CONCURRENCY, 1),
  // Plan steps (clone, triage, plan) one server works on at once.
  executionPlanConcurrency: parsePositiveInt(process.env.EXECUTION_PLAN_CONCURRENCY, 1),
  // Plans a person can ask to revise before the execution is blocked.
  planMaxVersions: parsePositiveInt(process.env.PLAN_MAX_VERSIONS, 5),
  consumerMaxAttempts: parsePositiveInt(process.env.CONSUMER_MAX_ATTEMPTS, 3),
  consumerRetryDelayMs: parsePositiveInt(
    process.env.CONSUMER_RETRY_DELAY_MS,
    30_000,
  ),
  llmRequestTimeoutMs: parsePositiveInt(
    process.env.LLM_REQUEST_TIMEOUT_MS,
    120_000,
  ),
  llmMaxOutputTokens: parsePositiveInt(
    process.env.LLM_MAX_OUTPUT_TOKENS,
    16_000,
  ),
  // JSON array of OpenAI-compatible provider profiles (services/llm/registry.ts).
  llmProviders: process.env.LLM_PROVIDERS ?? "",
  // Used when an agent has no provider/model set.
  llmDefaultProvider: process.env.LLM_DEFAULT_PROVIDER || "gemini",
  llmDefaultModel: process.env.LLM_DEFAULT_MODEL || "gemini-flash-latest",
  llmRateLimitRetries: parsePositiveInt(
    process.env.LLM_RATE_LIMIT_RETRIES,
    3,
  ),
  apiRateLimitPerMinute: parsePositiveInt(
    process.env.API_RATE_LIMIT_PER_MINUTE,
    120,
  ),
  connectorAllowedHosts: parseList(process.env.MCP_HTTP_ALLOWED_HOSTS).map(
    (host) => host.toLowerCase(),
  ),
  connectorAllowPrivateIps: process.env.MCP_HTTP_ALLOW_PRIVATE_IPS === "true",
  connectorTimeoutMs: parsePositiveInt(process.env.MCP_HTTP_TIMEOUT_MS, 10000),
  connectorMaxResponseBytes: parsePositiveInt(
    process.env.MCP_HTTP_MAX_RESPONSE_BYTES,
    1_000_000,
  ),
  generatedCodeMaxFiles: parsePositiveInt(
    process.env.GENERATED_CODE_MAX_FILES,
    25,
  ),
  generatedCodeMaxFileBytes: parsePositiveInt(
    process.env.GENERATED_CODE_MAX_FILE_BYTES,
    500_000,
  ),
  // single_shot: one implement call per attempt; tool_loop: the agent loop.
  executionAgentMode: parseAgentMode(process.env.EXECUTION_AGENT_MODE),
  // Model calls per attempt in tool_loop mode (an execution's budget.maxSteps wins).
  agentMaxSteps: parsePositiveInt(process.env.AGENT_MAX_STEPS, 30),
  // Tokens all model calls together may use per UTC day; 0 switches it off.
  llmDailyTokenLimit: parseNonNegativeInt(
    process.env.LLM_DAILY_TOKEN_LIMIT,
    2_000_000,
  ),
  // Budget given to each new execution (stored on it, so changing these
  // affects only executions created afterwards).
  executionMaxTokens: parsePositiveInt(process.env.EXECUTION_MAX_TOKENS, 200_000),
  executionMaxDurationSeconds: parsePositiveInt(
    process.env.EXECUTION_MAX_DURATION_SECONDS,
    1800,
  ),
  // Image for repositories that configure none and have no devcontainer:
  // a stock image with the common languages, pinned so it never changes
  // without notice. Mirror it to your own registry for production.
  executionDefaultImage:
    process.env.EXECUTION_DEFAULT_IMAGE || DEFAULT_EXECUTION_IMAGE,
  // Environments discovery may try (setup + baseline each) before a run
  // falls back to the default image. 0 turns discovery off.
  // A repository's environment snapshot is reused for this long, then rebuilt
  // from its image. 0 turns reuse off.
  executionSnapshotMaxAgeHours: parseNonNegativeInt(process.env.EXECUTION_SNAPSHOT_MAX_AGE_HOURS, 24),
  executionDiscoveryMaxAttempts: parseNonNegativeInt(process.env.EXECUTION_DISCOVERY_MAX_ATTEMPTS, 3),
  // While setup, a devcontainer build or a check runs, a progress event is
  // recorded this often (0 turns it off), and a step with no new output for
  // the second value is reported as possibly hung (0 never).
  executionProgressIntervalSeconds: parseNonNegativeInt(process.env.EXECUTION_PROGRESS_INTERVAL_SECONDS, 60),
  executionHungAfterSeconds: parseNonNegativeInt(process.env.EXECUTION_HUNG_AFTER_SECONDS, 600),
  // A run does not start below this much free disk (after a sweep of what
  // ended runs left). 0 turns the check off.
  executionMinFreeDiskGb: parseNonNegativeInt(process.env.EXECUTION_MIN_FREE_DISK_GB, 10),
  storeRawLlmOutput: process.env.STORE_RAW_LLM_OUTPUT === "true",
};

export const validateProductionConfig = (): void => {
  if (config.nodeEnv !== "production") return;

  const missing: string[] = [];
  if (!config.apiAuthToken) missing.push("API_AUTH_TOKEN");
  if (config.corsOrigins.length === 0) missing.push("CORS_ORIGINS");
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!process.env.ENCRYPTION_KEY) missing.push("ENCRYPTION_KEY");
  if (config.authDisabled)
    throw new Error("AUTH_DISABLED cannot be used in production");

  if (missing.length > 0) {
    throw new Error(
      `Missing required production configuration: ${missing.join(", ")}`,
    );
  }
};
