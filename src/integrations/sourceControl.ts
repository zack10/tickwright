import prisma from "../db";
import { openIntegrationConfig } from "../services/integrationConfigService";
import { NonRetryableError } from "../utils/safeError";
import { githubSourceControl } from "./githubApp";
import { SourceControlAdapter, SourceRepository } from "./types";

const adapters = new Map<string, SourceControlAdapter>();

export const registerSourceControlAdapter = (adapter: SourceControlAdapter) => {
  adapters.set(adapter.type, adapter);
};

registerSourceControlAdapter(githubSourceControl);
// Register other source-control adapters here.

/** Adapter for a Repository.provider or IntegrationConnection type, or undefined if there is none. */
export const getSourceControlAdapter = (type: string) => adapters.get(type);

/** The adapter's calls bound to one repository and its connection's config. */
export const bindSourceControl = (repository: SourceRepository, config: Record<string, unknown>) => {
  const adapter = getSourceControlAdapter(repository.provider);
  if (!adapter)
    throw new NonRetryableError(`No source-control adapter for provider ${repository.provider}`);
  const target = { repository, config };
  return {
    branchHead: (branch: string) => adapter.branchHead(target, branch),
    gitToken: () => adapter.gitToken(target),
    gitRemote: () => adapter.gitRemote(target),
    findOpenPullRequest: (head: string) => adapter.findOpenPullRequest(target, head),
    createDraftPullRequest: (input: Parameters<SourceControlAdapter["createDraftPullRequest"]>[1]) =>
      adapter.createDraftPullRequest(target, input),
    pullRequestOutcome: (number: number) => adapter.pullRequestOutcome(target, number),
    reviewFeedback: (number: number) => adapter.reviewFeedback(target, number),
  };
};

export type SourceControl = ReturnType<typeof bindSourceControl>;

/** The source control of a repository, with its connection's decrypted credentials. */
export const sourceControlFor = async (repository: SourceRepository): Promise<SourceControl> => {
  if (!repository.connectionId) return bindSourceControl(repository, {});
  const connection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: repository.connectionId } });
  return bindSourceControl(repository, openIntegrationConfig(connection.encryptedConfig));
};
