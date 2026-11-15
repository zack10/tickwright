-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "usageId" TEXT NOT NULL,
    "try" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "executionId" TEXT,
    "taskId" TEXT,
    "reasoningEffort" TEXT,
    "systemInstructions" TEXT,
    "inputMessages" JSONB NOT NULL,
    "toolDefinitions" JSONB,
    "outputMessages" JSONB,
    "errorType" TEXT,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmCall_createdAt_idx" ON "LlmCall"("createdAt");

-- CreateIndex
CREATE INDEX "LlmCall_executionId_startedAt_idx" ON "LlmCall"("executionId", "startedAt");
