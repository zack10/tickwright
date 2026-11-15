import { config } from "../../config";
import prisma, { json } from "../../db";
import { NonRetryableError } from "../../utils/safeError";

/** What a model call was for, so its tokens can be attributed. */
export interface UsageContext {
  purpose: string;
  executionId?: string;
  taskId?: string;
}

export interface UsageEntry extends UsageContext {
  /** Set by LLMService, so the call's LlmCall rows point at this row. */
  id?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * Where token usage is recorded and summed. Every model call is recorded,
 * whichever pipeline made it, so limits cover all of them together.
 */
export interface UsageLedger {
  record(entry: UsageEntry): Promise<void>;
  tokensUsedSince(since: Date): Promise<number>;
  tokensUsedByExecution(executionId: string): Promise<number>;
  /** One try of a model call, with its request and reply (LlmCall). */
  recordCall?(entry: CallEntry): Promise<void>;
}

/** Names taken from the OpenTelemetry GenAI conventions (gen_ai.input.messages and so on); the messages are ChatMessage. */
export interface CallEntry extends UsageContext {
  usageId: string;
  try: number;
  // Both of LLMService's calls go to a chat endpoint, which OpenTelemetry names "chat".
  operation: "chat";
  provider: string;
  model: string;
  reasoningEffort?: string;
  systemInstructions?: string;
  inputMessages: unknown;
  toolDefinitions?: unknown;
  outputMessages?: unknown;
  errorType?: string;
  error?: string;
  durationMs: number;
  startedAt: Date;
}

/** Deletes recorded requests and replies older than the retention; the token ledger stays. */
export const pruneLlmCalls = async (days = config.llmCallRetentionDays) =>
  days > 0 ? (await prisma.llmCall.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - days * 86_400_000) } } })).count : 0;

const total = (sum: {
  _sum: { inputTokens: number | null; outputTokens: number | null };
}) => (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0);

export const prismaUsageLedger: UsageLedger = {
  async record(entry) {
    await prisma.llmUsage.create({ data: entry });
  },
  async recordCall({ inputMessages, toolDefinitions, outputMessages, systemInstructions, error, ...entry }) {
    if (config.llmCallRetentionDays <= 0) return;
    // Text columns reject \u0000 as jsonb does.
    const text = (value?: string) => value?.replaceAll("\u0000", "�");
    await prisma.llmCall.create({
      data: {
        ...entry,
        systemInstructions: text(systemInstructions),
        error: text(error),
        inputMessages: json(inputMessages),
        ...(toolDefinitions === undefined ? {} : { toolDefinitions: json(toolDefinitions) }),
        ...(outputMessages === undefined ? {} : { outputMessages: json(outputMessages) }),
      },
    });
  },
  async tokensUsedSince(since) {
    return total(
      await prisma.llmUsage.aggregate({
        where: { createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    );
  },
  async tokensUsedByExecution(executionId) {
    return total(
      await prisma.llmUsage.aggregate({
        where: { executionId },
        _sum: { inputTokens: true, outputTokens: true },
      }),
    );
  },
};

/** A token limit is reached; retrying cannot help until it resets. */
export class TokenLimitError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "TokenLimitError";
    Object.setPrototypeOf(this, TokenLimitError.prototype);
  }
}

export const startOfUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
