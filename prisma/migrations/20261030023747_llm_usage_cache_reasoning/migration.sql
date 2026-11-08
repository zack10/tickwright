-- AlterTable
ALTER TABLE "LlmUsage" ADD COLUMN     "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reasoningTokens" INTEGER NOT NULL DEFAULT 0;
