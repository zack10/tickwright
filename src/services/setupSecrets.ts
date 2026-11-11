import prisma from "../db";
import { decrypt, encrypt } from "../utils/crypto";

/**
 * A repository's secrets, encrypted at rest and never in a response; a PATCH
 * replaces them all, null removes them.
 *
 * - Setup secrets (private registry tokens and the like): environment
 *   variables for its setup command only, never for the checks, the
 *   environment snapshot or the agent.
 * - Test secrets (test-grade API keys, feature flags): environment variables
 *   for the checks, which run in the agent's sandbox too, so the agent can
 *   read them. Never in the snapshot, masked in output, and never in a change.
 */
export const sealSetupSecrets = (secrets: Record<string, string> | null) =>
  secrets && Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null;
export const sealTestSecrets = sealSetupSecrets;

const open = (sealed: string | null) => (sealed ? (JSON.parse(decrypt(sealed)) as Record<string, string>) : {});

export const setupSecretsOf = async (repositoryId: string): Promise<Record<string, string>> =>
  open(
    (await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId }, select: { encryptedSetupSecrets: true } }))
      .encryptedSetupSecrets,
  );

export const testSecretsOf = async (repositoryId: string): Promise<Record<string, string>> =>
  open(
    (await prisma.repository.findUniqueOrThrow({ where: { id: repositoryId }, select: { encryptedTestSecrets: true } }))
      .encryptedTestSecrets,
  );

/** Every secret value of an execution's repository, for checks that a change contains none. */
export const secretValuesOfExecution = async (executionId: string) => {
  const { repositoryId } = await prisma.execution.findUniqueOrThrow({ where: { id: executionId }, select: { repositoryId: true } });
  return [...Object.values(await setupSecretsOf(repositoryId)), ...Object.values(await testSecretsOf(repositoryId))];
};
