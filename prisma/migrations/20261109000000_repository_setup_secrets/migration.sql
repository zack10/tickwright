-- Registry credentials and similar, encrypted, for the setup step only.
ALTER TABLE "Repository" ADD COLUMN "encryptedSetupSecrets" TEXT;
