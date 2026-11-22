-- DropIndex
DROP INDEX "Repository_owner_name_key";

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "connectionId" TEXT,
ALTER COLUMN "githubInstallationId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Repository_provider_owner_name_key" ON "Repository"("provider", "owner", "name");

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

