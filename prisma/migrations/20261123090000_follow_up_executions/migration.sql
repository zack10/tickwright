-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "parentExecutionId" TEXT;

-- CreateIndex
CREATE INDEX "Execution_parentExecutionId_idx" ON "Execution"("parentExecutionId");

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_parentExecutionId_fkey" FOREIGN KEY ("parentExecutionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

