-- CreateEnum
CREATE TYPE "FeedbackSource" AS ENUM ('TICKET_REPLY', 'PR_REVIEW');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "reviewers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ExecutionFeedback" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "source" "FeedbackSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "comments" JSONB NOT NULL DEFAULT '[]',
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addressedByExecutionId" TEXT,

    CONSTRAINT "ExecutionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionFeedback_executionId_addressedByExecutionId_idx" ON "ExecutionFeedback"("executionId", "addressedByExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionFeedback_source_externalId_key" ON "ExecutionFeedback"("source", "externalId");

-- AddForeignKey
ALTER TABLE "ExecutionFeedback" ADD CONSTRAINT "ExecutionFeedback_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

