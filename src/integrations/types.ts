import { ExternalSystem, IntegrationType, Prisma } from "@prisma/client";

/** A ticket from any tracker, in the shape the WorkItem table stores. */
export interface NormalizedWorkItem {
  externalId: string;
  boardId: string;
  title: string;
  description: string | null;
  labels: Prisma.InputJsonValue;
  sourceUrl: string | null;
  /**
   * Hash of the fields that should trigger a new execution when they change.
   * Must stay stable across releases: it is part of the execution
   * idempotency key, so changing the formula re-runs every existing ticket.
   */
  revisionHash: string;
  rawSnapshot: Prisma.InputJsonValue;
}

export interface TrackerFetchResult {
  /** Repository that executions for these items should target. */
  repositoryId: string;
  /** Only items the tracker config marks as eligible for automation. */
  items: NormalizedWorkItem[];
}

/** A comment on a ticket, as the conversation with the agent reads it. */
export interface TrackerComment {
  id: string;
  /** The tracker's own id for the author, and the name people know them by. */
  authorId: string;
  authorName: string;
  text: string;
  createdAt: Date;
}

/** The repository fields a source-control adapter needs. */
export interface SourceRepository {
  owner: string;
  name: string;
  githubInstallationId: string;
}

export interface PullRequestRef {
  number: number;
  html_url: string;
}

/**
 * Adapter for a source-control host (GitHub today, Phase 5 adds others).
 * Every API call to the host goes through it; git itself still runs in
 * workspaceService.
 */
export interface SourceControlAdapter {
  /** The commit a branch points at. */
  branchHead(repository: SourceRepository, branch: string): Promise<string>;
  /** A short-lived token for git over HTTPS (clone and push). */
  gitToken(repository: SourceRepository): Promise<string>;
  findOpenPullRequest(repository: SourceRepository, head: string): Promise<PullRequestRef | undefined>;
  createDraftPullRequest(
    repository: SourceRepository,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<PullRequestRef>;
}

/**
 * Adapter for an issue tracker (Trello today). Adapters only talk to the
 * tracker API; persistence and execution creation live in ingestionService.
 * `config` is the decrypted IntegrationConnection config.
 */
export interface IssueTrackerAdapter {
  type: IntegrationType;
  externalSystem: ExternalSystem;
  fetchEligibleItems(config: Record<string, unknown>): Promise<TrackerFetchResult>;
  comment(
    config: Record<string, unknown>,
    externalId: string,
    text: string,
  ): Promise<void>;
  /** Comments on the ticket made after `since`, oldest first. */
  fetchComments(
    config: Record<string, unknown>,
    externalId: string,
    since: Date,
  ): Promise<TrackerComment[]>;
}
