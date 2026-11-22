import { ExternalSystem, IntegrationType, Prisma, Repository } from "@prisma/client";
import { ZodType } from "zod";

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

/**
 * A repository as the database returns it (secret columns are omitted by
 * default). Each adapter reads the host's own fields from it.
 */
export type SourceRepository = Omit<Repository, "encryptedSetupSecrets" | "encryptedTestSecrets">;

/** What an adapter call works on: the repository and its connection's decrypted config ({} without one). */
export interface SourceControlTarget {
  repository: SourceRepository;
  config: Record<string, unknown>;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/** What happened to a pull request. */
export interface PullRequestOutcome {
  state: "OPEN" | "MERGED" | "CLOSED";
  closedAt?: Date;
  /** The pull request's changes as merged; undefined when the host cannot give them (too large). */
  diff?: string;
}

/** A comment on lines of the pull request's diff, inside a review. */
export interface ReviewLineComment {
  path: string;
  /** The commented line (the last one of a range), in the file as the reviewer saw it. */
  line: number;
  startLine?: number;
  /** The diff around the comment, ending at the commented line, as the reviewer saw it. */
  code: string;
  body: string;
  /** The code changed after the comment was written, so `line` may no longer point at it. */
  outdated: boolean;
}

/** A review, or a comment on the pull request's conversation, by one person. */
export interface ReviewFeedback {
  /** Unique across reviews and conversation comments of the host. */
  id: string;
  /** A review that blocks the PR (GitHub's "Request changes"); other feedback is context, not a request. */
  requestsChanges: boolean;
  author: string;
  /** Automated accounts never count as reviewers. */
  authorIsBot: boolean;
  body: string;
  submittedAt: Date;
  comments: ReviewLineComment[];
}

/** Where git clones from and pushes to, over HTTPS with the adapter's token. */
export interface GitRemote {
  /** An https:// clone URL; the token is sent to its origin only. */
  url: string;
  /** The user name paired with the token in HTTP Basic auth (each host has its own). */
  username: string;
}

/**
 * Adapter for a source-control host (GitHub today). Every host-specific
 * detail lives in it: API calls, the shape of its connection config, and the
 * git remote. Register it in sourceControl.ts; nothing else changes.
 */
export interface SourceControlAdapter {
  /** Repository.provider and IntegrationConnection.type of this host. */
  type: IntegrationType;
  /** Validates a connection's config when it is created. */
  configSchema: ZodType;
  /** The commit a branch points at. */
  branchHead(target: SourceControlTarget, branch: string): Promise<string>;
  /** A short-lived token for git over HTTPS (clone and push). */
  gitToken(target: SourceControlTarget): Promise<string>;
  gitRemote(target: SourceControlTarget): GitRemote;
  findOpenPullRequest(target: SourceControlTarget, head: string): Promise<PullRequestRef | undefined>;
  createDraftPullRequest(
    target: SourceControlTarget,
    input: { title: string; head: string; base: string; body: string },
  ): Promise<PullRequestRef>;
  pullRequestOutcome(target: SourceControlTarget, number: number): Promise<PullRequestOutcome>;
  /** The pull request's reviews and conversation comments, oldest first; approvals are not feedback. */
  reviewFeedback(target: SourceControlTarget, number: number): Promise<ReviewFeedback[]>;
}

/**
 * Adapter for an issue tracker (Trello today). Adapters only talk to the
 * tracker API; persistence and execution creation live in ingestionService.
 * `config` is the decrypted IntegrationConnection config.
 */
export interface IssueTrackerAdapter {
  type: IntegrationType;
  externalSystem: ExternalSystem;
  /** Validates a connection's config when it is created. */
  configSchema: ZodType;
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
