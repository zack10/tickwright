-- AlterTable
ALTER TABLE "ExecutionFeedback" ADD COLUMN     "fromBot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "verdict" TEXT,
ADD COLUMN     "verdictNote" TEXT;

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "reviewBots" TEXT[] DEFAULT ARRAY[]::TEXT[];
