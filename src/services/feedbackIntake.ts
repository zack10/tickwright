import { ExecutionStatus, FeedbackSource, Prisma } from "@prisma/client";

import prisma, { json } from "../db";
import { ReviewFeedback, IssueTrackerAdapter, ReviewLineComment } from "../integrations/types";
import { SourceControl } from "../integrations/sourceControl";
import { describeError } from "../utils/safeError";
import { isAgentComment, isApprover } from "./ticketConversation";

/*
 * Rules for untrusted text (roadmap Phase 7, limitation 23). Feedback on the
 * agent's open pull request is read only from people a person listed: the
 * tracker connection's `approvers` for ticket replies, `Repository.reviewers`
 * for code-host reviews, `Repository.reviewBots` for review bots' findings
 * (step 10). Text from anyone else, from other bots and from the agent
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
  fromBot?: boolean;
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

/**
 * A review bot listed by exact login (`Repository.reviewBots`, step 10). Its
 * text reaches a round only as findings the agent checks one by one, and
 * starts nothing (roadmap Phase 7, step 10).
 */
export const isListedBot = (review: Pick<ReviewFeedback, "author" | "authorIsBot">, bots: string[]) =>
  review.authorIsBot && review.author !== "" && bots.some((bot) => bot.toLowerCase() === review.author.toLowerCase());

/**
 * One finding per line comment of a listed bot's review, so each gets its own
 * verdict and reply; the summary of a review that has line comments says
 * nothing they do not (Devin on dynamic-csv PR #38: "found 3 potential issues").
 */
const botFindings = (executionId: string, review: ReviewFeedback): FeedbackRow[] => {
  const base = { executionId, source: "PR_REVIEW" as const, author: review.author, requestsChanges: false, fromBot: true };
  if (!review.comments.length)
    return review.body.trim() ? [{ ...base, externalId: review.id, body: review.body, writtenAt: review.submittedAt }] : [];
  return review.comments.slice(0, MAX_LINE_COMMENTS).map((comment, index) => ({
    ...base,
    externalId: `${review.id}:${comment.id ?? index}`,
    body: "",
    comments: [comment],
    // Keeps the review's order of its comments, which the round numbers its findings by.
    writtenAt: new Date(review.submittedAt.getTime() + index),
  }));
};

/** The listed reviewers' reviews and conversation comments, and listed bots' reviews, on an execution's open pull request. */
export const collectReviewFeedback = async (
  execution: { id: string; repository: { reviewers: string[]; reviewBots?: string[] } },
  sourceControl: Pick<SourceControl, "reviewFeedback">,
  pullRequest: number,
) => {
  const { reviewers } = execution.repository;
  const bots = execution.repository.reviewBots ?? [];
  // Bots start nothing, so without a listed person no round would ever read them.
  if (!reviewers?.length) return 0;
  const feedback = await sourceControl.reviewFeedback(pullRequest);
  const reviews = feedback.filter((review) => isListedReviewer(review, reviewers));
  // A bot's conversation comments are status notes (CI summaries, badges), not reviews.
  const botReviews = feedback.filter((review) => !review.id.startsWith("comment:") && isListedBot(review, bots));
  return store([
    ...reviews
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
    ...botReviews.flatMap((review) => botFindings(execution.id, review)),
  ]);
};

const ENDED: ExecutionStatus[] = ["COMPLETED", "BLOCKED", "FAILED", "CANCELED"];

/**
 * Checks that failed on the pull request's latest commit (`head`), once all
 * of them finished, so one round covers all of a commit's failures. A check
 * that fails on the commit the change started from was broken before it and
 * is skipped. Off, like reviews, until the repository lists a reviewer, and
 * not read while a round runs: that round is about to change the head.
 */
export const collectCheckFeedback = async (
  execution: { id: string; baseSha: string | null; repository: { reviewers: string[] } },
  sourceControl: Pick<SourceControl, "commitChecks">,
  head: string,
) => {
  if (!execution.repository.reviewers?.length) return 0;
  if (await prisma.execution.count({ where: { parentExecutionId: execution.id, status: { notIn: ENDED } } })) return 0;
  const checks = await sourceControl.commitChecks(head);
  if (checks.pending || !checks.failed.length) return 0;
  const before = execution.baseSha ? await sourceControl.commitChecks(execution.baseSha) : undefined;
  const failingBefore = new Set(before?.failed.map((check) => check.name));
  // One item per name: workflows often run a job of the same name (PR #10 of dynamic-csv-batch-processor had two "test").
  const byName = new Map<string, { check: (typeof checks.failed)[number]; count: number }>();
  for (const check of checks.failed.filter((check) => !failingBefore.has(check.name))) {
    const seen = byName.get(check.name);
    if (seen) seen.count++;
    else byName.set(check.name, { check, count: 1 });
  }
  return store(
    [...byName.values()].map(({ check, count }) => ({
      executionId: execution.id,
      source: "CI_CHECK" as const,
      // Per commit and name: the same check failing again after a round is new feedback.
      externalId: `${head}:${check.name}`,
      author: check.name,
      body: `The check "${check.name}" ended with "${check.conclusion}" on commit ${head.slice(0, 12)}${count > 1 ? ` (${count} runs of it failed; the first one's output)` : ""}. Where it failed in its output:\n${check.output}`,
      requestsChanges: true,
      writtenAt: new Date(),
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
      // Feedback belongs to the execution that opened the pull request, not to a follow-up round.
      parentExecutionId: null,
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
