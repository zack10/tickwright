import dotenv from "dotenv";
import { config } from "../../config";
import { NonRetryableError, describeError } from "../../utils/safeError";
import { ProviderRegistry, getProviderRegistry } from "./registry";
import { withLLMRetry } from "./retry";
import {
  LLMProvider,
  Model,
  TextPrompt,
  TokenUsage,
  ToolRequest,
  ToolTurn,
  UsageStats,
} from "./types";
import {
  TokenLimitError,
  UsageContext,
  UsageLedger,
  prismaUsageLedger,
  startOfUtcDay,
} from "./usageLedger";

dotenv.config();

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

  /** Records a call's usage. A failed write is logged, never thrown: the tokens are already spent. */
  private async record(
    provider: string,
    model: string,
    usage: TokenUsage | undefined,
    context: UsageContext | undefined,
  ) {
    if (!this.ledger) return;
    try {
      await this.ledger.record({
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
    const result = await withLLMRetry(
      () => provider.generateContent(model, prompt, apiKey),
      { retries: config.llmRateLimitRetries },
    );
    await this.record(providerKey, model, result.usage, context);
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
    const turn = await withLLMRetry(
      () => provider.generateWithTools(model, request, apiKey),
      { retries: config.llmRateLimitRetries },
    );
    await this.record(providerKey, model, turn.usage, context);
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
