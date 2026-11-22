import { FeedbackSource, Prisma } from "@prisma/client";

import prisma, { json } from "../db";
import { ReviewFeedback, IssueTrackerAdapter, ReviewLineComment } from "../integrations/types";
import { SourceControl } from "../integrations/sourceControl";
import { describeError } from "../utils/safeError";
import { isAgentComment, isApprover } from "./ticketConversation";

/*
 * Rules for untrusted text (roadmap Phase 7, limitation 23). Feedback on the
 * agent's open pull request is read only from people a person listed: the
 * tracker connection's `approvers` for ticket replies, `Repository.reviewers`
 * for code-host reviews. Text from anyone else, from bots and from the agent
 * itself is never stored, so it can never reach a prompt. What is stored is
 * capped. Nothing here starts work: a follow-up execution (step 4b) does,
 * through the same policy, verification, review and publish approval.
 */

export const MAX_BODY_CHARS = 4000;
export const MAX_LINE_COMMENTS = 50;
const MAX_COMMENT_CHARS = 2000;
// The commented line is at the end of the excerpt, so the end is kept.
const MAX_CODE_CHARS = 3000;
// Recorded by pullRequestOutcomes.ts once the PR is merged or closed (not imported: that file imports this one).
const OUTCOME_EVENT = "PULL_REQUEST_OUTCOME";

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text);
const tail = (text: string, max: number) => (text.length > max ? `[start cut]\n${text.slice(-max)}` : text);

export const limitLineComments = (comments: ReviewLineComment[]) =>
  comments.slice(0, MAX_LINE_COMMENTS).map((comment) => ({
    ...comment,
    body: cut(comment.body, MAX_COMMENT_CHARS),
    code: tail(comment.code, MAX_CODE_CHARS),
  }));

/** A code-host login listed as a reviewer; "@name" and case do not matter. Bots never count. */
export const isListedReviewer = (review: Pick<ReviewFeedback, "author" | "authorIsBot">, reviewers: string[]) =>
  !review.authorIsBot &&
  review.author !== "" &&
  reviewers.some((reviewer) => reviewer.replace(/^@/, "").toLowerCase() === review.author.toLowerCase());

type FeedbackRow = {
  executionId: string;
  source: FeedbackSource;
  externalId: string;
  author: string;
  body: string;
  comments?: ReviewLineComment[];
  /** Whether it starts a new round of changes (step 4b), or is context for the next one. */
  requestsChanges: boolean;
  writtenAt: Date;
};

/** Stores each request once (polls see the same comments again); returns how many were new. */
const store = async (rows: FeedbackRow[]) => {
  if (!rows.length) return 0;
  const { count } = await prisma.executionFeedback.createMany({
    data: rows.map((row) => ({
      ...row,
      body: cut(row.body, MAX_BODY_CHARS),
      comments: json(limitLineComments(row.comments ?? [])) as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  return count;
};

/** The listed reviewers' reviews and conversation comments on an execution's open pull request. */
export const collectReviewFeedback = async (
  execution: { id: string; repository: { reviewers: string[] } },
  sourceControl: Pick<SourceControl, "reviewFeedback">,
  pullRequest: number,
) => {
  const { reviewers } = execution.repository;
  if (!reviewers?.length) return 0;
  const reviews = (await sourceControl.reviewFeedback(pullRequest)).filter((review) => isListedReviewer(review, reviewers));
  return store(
    reviews
      // A review with neither a summary nor line comments asks for nothing in particular.
      .filter((review) => review.body.trim() || review.comments.length)
      .map((review) => ({
        executionId: execution.id,
        source: "PR_REVIEW" as const,
        externalId: review.id,
        requestsChanges: review.requestsChanges,
        author: review.author,
        body: review.body,
        comments: review.comments,
        writtenAt: review.submittedAt,
      })),
  );
};

/**
 * Approvers' replies on tickets whose execution opened a pull request that is
 * still open (no recorded outcome). Commands, empty replies and the agent's
 * own comments are not feedback; other people's replies are ignored silently,
 * since a finished ticket is still a place people talk.
 */
export const collectTicketFeedback = async (adapter: IssueTrackerAdapter, trackerConfig: Record<string, unknown>) => {
  const approvers = Array.isArray(trackerConfig.approvers)
    ? trackerConfig.approvers.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  if (!approvers.length) return 0;
  const executions = await prisma.execution.findMany({
    where: {
      repositoryId: String(trackerConfig.repositoryId),
      status: "COMPLETED",
      completedAt: { not: null },
      workItem: { externalSystem: adapter.externalSystem },
      artifacts: { some: { type: "PULL_REQUEST" } },
      events: { none: { type: OUTCOME_EVENT } },
    },
    include: { workItem: true },
  });
  let stored = 0;
  for (const execution of executions)
    try {
      // Replies before the PR opened were about the plan or the change, and were handled then.
      const since = execution.completedAt as Date;
      const replies = (await adapter.fetchComments(trackerConfig, execution.workItem.externalId, since)).filter((comment) => {
        const text = comment.text.trim();
        return comment.createdAt > since && text && !isAgentComment(text) && !text.startsWith("/") && isApprover(comment, approvers);
      });
      stored += await store(
        replies.map((comment) => ({
          executionId: execution.id,
          source: "TICKET_REPLY" as const,
          externalId: `${adapter.externalSystem}:${comment.id}`,
          author: comment.authorName,
          body: comment.text,
          // A tracker has no "comment only" kind of reply: every approver reply asks for something.
          requestsChanges: true,
          writtenAt: comment.createdAt,
        })),
      );
    } catch (error) {
      console.error(`Ticket feedback for execution ${execution.id} failed: ${describeError(error)}`);
    }
  return stored;
};
