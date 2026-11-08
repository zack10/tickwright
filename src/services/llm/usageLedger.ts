import prisma from "../../db";
import { NonRetryableError } from "../../utils/safeError";

/** What a model call was for, so its tokens can be attributed. */
export interface UsageContext {
  purpose: string;
  executionId?: string;
  taskId?: string;
}

export interface UsageEntry extends UsageContext {
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
}

const total = (sum: {
  _sum: { inputTokens: number | null; outputTokens: number | null };
}) => (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0);

export const prismaUsageLedger: UsageLedger = {
  async record(entry) {
    await prisma.llmUsage.create({ data: entry });
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
