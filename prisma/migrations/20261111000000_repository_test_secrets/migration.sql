-- Environment variables for the checks (test-grade API keys, feature flags), encrypted.
ALTER TABLE "Repository" ADD COLUMN "encryptedTestSecrets" TEXT;
