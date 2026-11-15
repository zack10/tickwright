import { randomUUID } from "node:crypto";
import axios from "axios";
import dotenv from "dotenv";
import { config } from "../../config";
import { NonRetryableError, describeError } from "../../utils/safeError";
import { ProviderRegistry, getProviderRegistry } from "./registry";
import { providerMessage, withLLMRetry } from "./retry";
import {
  ChatMessage,
  LLMProvider,
  Model,
  TextPrompt,
  TokenUsage,
  ToolRequest,
  ToolTurn,
  UsageStats,
} from "./types";
import {
  CallEntry,
  TokenLimitError,
  UsageContext,
  UsageLedger,
  prismaUsageLedger,
  startOfUtcDay,
} from "./usageLedger";

dotenv.config();

/** Names a call in the retry log: which model, what for, which execution. */
const callLabel = (providerKey: string, model: string, context?: UsageContext) =>
  `LLM ${providerKey}/${model}${context ? ` (${context.purpose}${context.executionId ? `, execution ${context.executionId}` : ""})` : ""}`;

/** OpenTelemetry's error.type: the HTTP status, else the error's code or class. */
const errorType = (error: unknown) =>
  axios.isAxiosError(error) ? String(error.response?.status ?? error.code ?? "AxiosError") : error instanceof Error ? error.name : "Error";

// The provider's raw reply is already stored with the call that produced it; repeating it in every later request would multiply the table's size.
const withoutRaw = (messages: ChatMessage[]) =>
  messages.map((message) => (message.role === "assistant" ? { ...message, raw: undefined } : message));

type CallRequest = Omit<CallEntry, "usageId" | "try" | "outputMessages" | "errorType" | "error" | "durationMs" | "startedAt">;

/**
 * Main LLM Service handling provider discovery and routing
 */
export class LLMService {
  constructor(
    // Resolved on first use, so importing this module never reads provider config.
    private readonly customRegistry?: ProviderRegistry,
    // Every call's tokens are recorded here and checked against the daily
    // limit. null records nothing and enforces no limit (unit tests).
    private readonly ledger: UsageLedger | null = prismaUsageLedger,
    private readonly dailyTokenLimit = config.llmDailyTokenLimit,
  ) {}

  private get registry(): ProviderRegistry {
    return this.customRegistry ?? getProviderRegistry();
  }

  private provider(providerKey: string): LLMProvider {
    return this.registry.get(providerKey);
  }

  /**
   * The provider and model an agent runs on. An agent without a provider uses
   * the configured default; one with a provider but no model is a setup
   * error, since the default model belongs to the default provider.
   */
  resolveModel(agent: {
    provider?: string | null;
    model?: string | null;
  }): { provider: string; model: string } {
    const provider = agent.provider || this.registry.defaultProvider;
    if (!this.registry.has(provider))
      throw new NonRetryableError(`Agent provider "${provider}" is not configured`);
    if (agent.model) return { provider, model: agent.model };
    if (provider === this.registry.defaultProvider)
      return { provider, model: this.registry.defaultModel };
    throw new NonRetryableError(`Agent uses provider "${provider}" but has no model set`);
  }

  /** Tokens used today (UTC) by all model calls, against the daily limit. */
  async usageToday(): Promise<{ used: number; limit: number; resetsAt: Date }> {
    const start = startOfUtcDay();
    return {
      used: this.ledger ? await this.ledger.tokensUsedSince(start) : 0,
      limit: this.dailyTokenLimit,
      resetsAt: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    };
  }

  /**
   * Refuses a new call once today's usage reached the limit, so many
   * executions together cannot run up an unbounded bill. A call that is
   * started always completes, so the limit can be passed by one call.
   */
  private async checkDailyLimit() {
    if (!this.ledger || this.dailyTokenLimit <= 0) return;
    const { used, limit, resetsAt } = await this.usageToday();
    if (used >= limit)
      throw new TokenLimitError(
        `Daily LLM token limit reached: ${used} of ${limit} tokens used today (LLM_DAILY_TOKEN_LIMIT; resets at ${resetsAt.toISOString()})`,
      );
  }

  /**
   * Wraps one try of a call so each try, failed ones too, is recorded with
   * its request, reply or error and duration. The write is not awaited and a
   * failed write is only logged: recording never slows or fails the call.
   * The error is rethrown unchanged, since the retry loop inspects it.
   */
  private recordTries<T>(usageId: string, request: CallRequest, call: () => Promise<T>, output: (result: T) => unknown) {
    let tries = 0;
    return async () => {
      const startedAt = new Date();
      const tryNumber = ++tries;
      const save = (fields: Pick<CallEntry, "outputMessages" | "errorType" | "error">) => {
        const ledger = this.ledger;
        if (!ledger?.recordCall) return;
        const entry = { ...request, ...fields, usageId, try: tryNumber, startedAt, durationMs: Date.now() - startedAt.getTime() };
        void Promise.resolve()
          .then(() => ledger.recordCall?.(entry))
          .catch((error) => console.error(`Recording LLM call failed: ${describeError(error)}`));
      };
      try {
        const result = await call();
        save({ outputMessages: output(result) });
        return result;
      } catch (error) {
        const reason = providerMessage(error);
        save({ errorType: errorType(error), error: `${describeError(error)}${reason ? `: ${reason}` : ""}` });
        throw error;
      }
    };
  }

  /** Records a call's usage. A failed write is logged, never thrown: the tokens are already spent. */
  private async record(
    provider: string,
    model: string,
    usage: TokenUsage | undefined,
    context: UsageContext | undefined,
    id?: string,
  ) {
    if (!this.ledger) return;
    try {
      await this.ledger.record({
        id,
        provider,
        model,
        purpose: context?.purpose ?? "unattributed",
        executionId: context?.executionId,
        taskId: context?.taskId,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
      });
    } catch (error) {
      console.error(`Recording LLM usage failed: ${describeError(error)}`);
    }
  }

  private attribution(provider: string, model: string, context: UsageContext | undefined) {
    return {
      provider,
      model,
      purpose: context?.purpose ?? "unattributed",
      executionId: context?.executionId,
      taskId: context?.taskId,
    };
  }

  /**
   * List all available models for a specific provider
   */
  async listModels(providerKey: string, apiKey?: string): Promise<Model[]> {
    return this.provider(providerKey).listModels(apiKey);
  }

  /**
   * Generate content using specified model
   */
  async generateContent(
    providerKey: string,
    model: string,
    prompt: TextPrompt,
    apiKey?: string,
    context?: UsageContext,
  ): Promise<string> {
    const provider = this.provider(providerKey);
    await this.checkDailyLimit();
    const usageId = randomUUID();
    const request: CallRequest = {
      ...this.attribution(providerKey, model, context),
      operation: "chat",
      reasoningEffort: prompt.reasoningEffort,
      systemInstructions: prompt.system,
      inputMessages: [{ role: "user", content: prompt.user }],
    };
    const result = await withLLMRetry(
      this.recordTries(usageId, request, () => provider.generateContent(model, prompt, apiKey), (reply) => [
        { role: "assistant", content: reply.text },
      ]),
      { retries: config.llmRateLimitRetries, label: callLabel(providerKey, model, context) },
    );
    await this.record(providerKey, model, result.usage, context, usageId);
    return result.text;
  }

  /**
   * One model turn with tools available. The caller runs any returned tool
   * calls, appends `turn.message` and the results, and calls again until
   * `stopReason` is "end_turn".
   */
  async generateWithTools(
    providerKey: string,
    model: string,
    request: ToolRequest,
    apiKey?: string,
    context?: UsageContext,
  ): Promise<ToolTurn> {
    const provider = this.provider(providerKey);
    // Fail before spending a request: a text-only endpoint would ignore the tools.
    if (!this.registry.supportsTools(providerKey))
      throw new NonRetryableError(
        `Provider "${providerKey}" does not support tool calling (set "supportsTools": true in its LLM_PROVIDERS profile if it does)`,
      );
    await this.checkDailyLimit();
    const usageId = randomUUID();
    const sent: CallRequest = {
      ...this.attribution(providerKey, model, context),
      operation: "chat",
      reasoningEffort: request.reasoningEffort,
      systemInstructions: request.system,
      inputMessages: withoutRaw(request.messages),
      toolDefinitions: request.tools,
    };
    const turn = await withLLMRetry(
      this.recordTries(usageId, sent, () => provider.generateWithTools(model, request, apiKey), (reply) => [
        { ...reply.message, finishReason: reply.stopReason },
      ]),
      { retries: config.llmRateLimitRetries, label: callLabel(providerKey, model, context) },
    );
    await this.record(providerKey, model, turn.usage, context, usageId);
    return turn;
  }

  /**
   * Test a provider key and discover available models/quotas
   */
  async discover(
    providerKey: string,
    apiKey: string,
  ): Promise<{ models: Model[]; usage: UsageStats }> {
    const provider = this.provider(providerKey);
    const [models, usage] = await Promise.all([
      provider.listModels(apiKey),
      provider.getUsage(apiKey),
    ]);

    return { models, usage };
  }

  /**
   * Get usage statistics for a provider
   */
  async getUsage(providerKey: string, apiKey?: string): Promise<UsageStats> {
    return this.provider(providerKey).getUsage(apiKey);
  }
}
