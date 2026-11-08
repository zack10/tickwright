-- CreateTable
CREATE TABLE "GraphCheckpoint" (
    "executionId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphCheckpoint_pkey" PRIMARY KEY ("executionId")
);
