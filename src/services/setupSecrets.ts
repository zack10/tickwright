import prisma from "../db";
import { decrypt, encrypt } from "../utils/crypto";

/**
 * A repository's setup secrets (private registry tokens and the like):
 * environment variables for its setup command only, never for the checks,
 * the environment snapshot or the agent. Encrypted at rest and never in a
 * response; a PATCH replaces them all, null removes them.
 */
export const sealSetupSecrets = (secrets: Record<string, string> | null) =>
  secrets && Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null;

export const setupSecretsOf = async (repositoryId: string): Promise<Record<string, string>> => {
  const { encryptedSetupSecrets } = await prisma.repository.findUniqueOrThrow({
    where: { id: repositoryId },
    select: { encryptedSetupSecrets: true },
  });
  return encryptedSetupSecrets ? (JSON.parse(decrypt(encryptedSetupSecrets)) as Record<string, string>) : {};
};

export const setupSecretsOfExecution = async (executionId: string) =>
  setupSecretsOf((await prisma.execution.findUniqueOrThrow({ where: { id: executionId }, select: { repositoryId: true } })).repositoryId);
