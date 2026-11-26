import { ExecutionFeedback, ExecutionStatus } from "@prisma/client";

import prisma from "../db";
import { sourceControlFor } from "../integrations/sourceControl";
import { ReviewLineComment } from "../integrations/types";
import { EXECUTION_PROMPTS, executionPromptFragment } from "../prompts";
import { describeError } from "../utils/safeError";
import { graphEvent } from "./agentGraph/agentCalls";
import { createFollowUpExecution } from "./executionService";
import { commentOnWorkItem } from "./ingestionService";
import type { Finding } from "./sandbox/tools";
import { signed } from "./ticketConversation";

/*
 * Follow-up rounds (roadmap Phase 7, step 4b). Feedback that feedbackIntake.ts
 * stored on an open pull request starts a new execution on the same branch;
 * one round runs at a time per pull request, and what arrives meanwhile goes
 * into the next one.
 */

const ENDED: ExecutionStatus[] = ["COMPLETED", "BLOCKED", "FAILED", "CANCELED"];
// Recorded by pullRequestOutcomes.ts once the PR is merged or closed (not imported: that file imports this one).
const OUTCOME_EVENT = "PULL_REQUEST_OUTCOME";
// Each item is capped when stored (feedbackIntake.ts); this caps a round's prompt.
export const MAX_FEEDBACK_PER_ROUND = 20;
// Rounds per pull request unless Repository.executionPolicy.maxFollowUpRounds says otherwise; a check the agent cannot fix would start one after every push. 20 so people's own review cycles are rarely cut short (chosen 2026-11-23).
export const DEFAULT_MAX_FOLLOW_UP_ROUNDS = 20;
const ROUND_LIMIT_EVENT = "FOLLOW_UP_LIMIT_REACHED";

const CONFLICT_EVENT = "PULL_REQUEST_CONFLICT";

/** The note posted when the pull request's branch conflicts with its target. */
export const formatConflictComment = (base: string) =>
  `**This pull request has a merge conflict with \`${base}\`.** I don't resolve conflicts myself: ` +
  `merge \`${base}\` into the branch or rebase it, and fix the conflicting files. Feedback after that works as before.`;

/**
 * Hands a conflict back to the person on the pull request and the ticket,
 * once per commit of the branch: a person's fix moves the branch, and a later
 * conflict is told again. The agent does not resolve conflicts (roadmap Phase 7).
 */
export const handBackConflict = async (
  root: { id: string; projectId: string; workItem: Parameters<typeof commentOnWorkItem>[1] },
  sourceControl: Pick<Awaited<ReturnType<typeof sourceControlFor>>, "commentOnPullRequest">,
  number: number,
  conflict: { head: string; base: string },
) => {
  const told = await prisma.executionEvent.count({ where: { executionId: root.id, type: CONFLICT_EVENT, payload: { path: ["head"], equals: conflict.head } } });
  if (told) return false;
  await graphEvent(root.id, CONFLICT_EVENT, conflict);
  const note = formatConflictComment(conflict.base);
  await commentOnWorkItem(root.projectId, root.workItem, note).catch((error) =>
    console.error(`Conflict note on the ticket failed for ${root.id}: ${describeError(error)}`),
  );
  await sourceControl.commentOnPullRequest(number, note).catch((error) =>
    console.error(`Conflict note on the pull request failed for ${root.id}: ${describeError(error)}`),
  );
  return true;
};

/** The note posted once when a pull request has used its rounds. */
export const formatRoundLimitComment = (rounds: number) =>
  (rounds
    ? `**I've made ${rounds} follow-up round${rounds === 1 ? "" : "s"} on this pull request, the limit for this repository.** `
    : "**Follow-up rounds are turned off for this repository.** ") +
  "Over to you: change the branch yourself, or raise `maxFollowUpRounds` in the repository's execution policy and I'll act on the feedback that is waiting.";

const quote = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const describeLineComment = (comment: ReviewLineComment) =>
  [
    `On ${comment.path} line ${comment.startLine && comment.startLine !== comment.line ? `${comment.startLine}-` : ""}${comment.line}${comment.outdated ? " (outdated)" : ""}, the diff the reviewer saw:`,
    quote(comment.code),
    "Their comment:",
    quote(comment.body),
  ].join("\n");

/** Who gave a piece of feedback and where: a person on the PR or ticket, or a check that failed. */
const origin = (item: Pick<ExecutionFeedback, "source" | "author"> & { fromBot?: boolean }) =>
  item.source === "CI_CHECK"
    ? `the check "${item.author}" on the pull request's latest commit`
    : item.fromBot
      ? `the review bot ${item.author} on the pull request`
      : `${item.author || "unknown"} on the ${item.source === "PR_REVIEW" ? "pull request" : "ticket"}`;

type DescribedFeedback = Pick<ExecutionFeedback, "source" | "author" | "body" | "comments" | "requestsChanges"> & { fromBot?: boolean };

/** The feedback as the agent reads it: every line of people's text and of check output is quoted, so none of it can pass for an instruction. */
export const describeFeedback = (items: DescribedFeedback[]) =>
  items
    .map((item, index) => {
      const comments = Array.isArray(item.comments) ? (item.comments as unknown as ReviewLineComment[]) : [];
      return [
        `Feedback ${index + 1} (${item.fromBot ? "finding" : item.requestsChanges ? "request" : "context"}), from ${origin(item)}:`,
        item.body.trim() ? quote(item.body.trim()) : "",
        ...comments.map(describeLineComment),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

/**
 * The test files the pull request changed before this round, as the round's
 * prompts list them: the reviewer and the failure analysis otherwise judge
 * them as the repository's locked tests (dynamic-csv PR #17, round c106c31f).
 */
export const describeOwnTests = (changes: { status: string; file: string }[]) =>
  changes
    .map((change) =>
      change.status === "A"
        ? `- ${change.file}: added by this pull request`
        : change.status === "D"
          ? `- ${change.file}: deleted by this pull request`
          : `- ${change.file}: was there before the pull request, which added or changed lines in it; only the lines it had before are locked`,
    )
    .join("\n") || "- none: every test file is as it was before the pull request";

/** A round's feedback in the order its ticket numbers it; the id breaks ties so the tools number findings alike. */
const roundFeedback = (executionId: string) =>
  prisma.executionFeedback.findMany({
    where: { addressedByExecutionId: executionId },
    orderBy: [{ writtenAt: "asc" }, { id: "asc" }],
  });

/** The review bots' findings of a round, numbered as its ticket shows them, for answer_finding (step 10). */
export const roundFindings = async (executionId: string): Promise<Finding[]> =>
  (await roundFeedback(executionId)).flatMap((item, index) => (item.fromBot ? [{ number: index + 1, feedbackId: item.id }] : []));

const VERDICTS = { fixed: "FIXED", not_changed: "NOT_CHANGED", needs_decision: "NEEDS_DECISION" } as const;

/** Stores the attempt's answers; a finding left unanswered is a person's decision. Each attempt replaces the last one's. */
export const saveFindingAnswers = async (findings: Finding[] = []) => {
  for (const finding of findings)
    await prisma.executionFeedback.update({
      where: { id: finding.feedbackId },
      data: finding.answer
        ? { verdict: VERDICTS[finding.answer.verdict], verdictNote: finding.answer.test ? `${finding.answer.reason} (test: ${finding.answer.test})` : finding.answer.reason }
        : { verdict: "NEEDS_DECISION", verdictNote: "The agent did not answer it." },
    });
};

/** A round with findings and no change can end with its answers only when none says "fixed" and every one was answered. */
export const onlyAnswers = (findings: Finding[] = []) =>
  findings.length > 0 && findings.every((finding) => finding.answer && finding.answer.verdict !== "fixed");

const VERDICT_WORDS: Record<string, string> = {
  FIXED: "Fixed",
  NOT_CHANGED: "Not changed",
  NEEDS_DECISION: "Needs a person's decision",
};

/** The reply in a finding's thread: the verdict and its reason. */
export const formatFindingReply = (verdict: string, note: string | null, pushed: boolean) =>
  `**${VERDICT_WORDS[verdict] ?? verdict}${verdict === "FIXED" && pushed ? " in the commit pushed for this round" : ""}.** ${note ?? ""}`.trim();

/**
 * Posts each answered finding of a round in its thread, and a summary on the
 * pull request and the ticket, once (`repliedAt`). `pushed`: the round's
 * commit is on the branch; a round that changed nothing says so.
 */
export const replyToFindings = async (
  round: { id: string; projectId: string; workItem: Parameters<typeof commentOnWorkItem>[1] },
  sourceControl: Pick<Awaited<ReturnType<typeof sourceControlFor>>, "commentOnPullRequest" | "replyToReviewComment">,
  number: number,
  pushed: boolean,
) => {
  const findings = await prisma.executionFeedback.findMany({
    where: { addressedByExecutionId: round.id, fromBot: true, verdict: { not: null }, repliedAt: null },
    orderBy: [{ writtenAt: "asc" }, { id: "asc" }],
  });
  if (!findings.length) return 0;
  const lines: string[] = [];
  const sent: string[] = [];
  for (const finding of findings) {
    const reply = signed(formatFindingReply(finding.verdict as string, finding.verdictNote, pushed));
    const comment = (Array.isArray(finding.comments) ? (finding.comments as unknown as ReviewLineComment[]) : [])[0];
    // A failed reply stays unsent, so the next PR poll tries it again (retryFindingReplies).
    const ok = !comment?.id || (await sourceControl.replyToReviewComment(number, comment.id, reply).then(() => true, (error) => {
      console.error(`Reply to finding ${finding.id} failed: ${describeError(error)}`);
      return false;
    }));
    if (!ok) continue;
    sent.push(finding.id);
    const where = comment ? `${comment.path} line ${comment.line}` : "review";
    lines.push(`- ${VERDICT_WORDS[finding.verdict as string] ?? finding.verdict}: ${finding.author}'s finding on ${where}. ${finding.verdictNote ?? ""}`.trim());
  }
  if (!sent.length) return 0;
  await prisma.executionFeedback.updateMany({ where: { id: { in: sent } }, data: { repliedAt: new Date() } });
  const summary = [
    pushed
      ? `**My answers to the review bot's findings** (the fixes are in the commit pushed for this round):`
      : `**My answers to the review bot's findings.** None needed a change, so nothing was pushed:`,
    ...lines,
  ].join("\n");
  await commentOnWorkItem(round.projectId, round.workItem, summary).catch((error) =>
    console.error(`Findings summary on the ticket failed for ${round.id}: ${describeError(error)}`),
  );
  await sourceControl.commentOnPullRequest(number, signed(summary)).catch((error) =>
    console.error(`Findings summary on the pull request failed for ${round.id}: ${describeError(error)}`),
  );
  return sent.length;
};

/** Posts the answers of a pull request's finished rounds that failed to post before; a round waiting for publish approval is not finished. */
export const retryFindingReplies = async (
  rootId: string,
  sourceControl: Parameters<typeof replyToFindings>[1],
  number: number,
) => {
  const unsent = await prisma.executionFeedback.findMany({
    where: { executionId: rootId, fromBot: true, verdict: { not: null }, repliedAt: null, addressedByExecutionId: { not: null } },
    select: { addressedByExecutionId: true },
    distinct: ["addressedByExecutionId"],
  });
  if (!unsent.length) return;
  const rounds = await prisma.execution.findMany({
    where: { id: { in: unsent.map((row) => row.addressedByExecutionId as string) }, parentExecutionId: rootId, status: "COMPLETED" },
    include: { workItem: true, artifacts: { where: { type: "PULL_REQUEST" }, take: 1 } },
  });
  for (const round of rounds) await replyToFindings(round, sourceControl, number, round.artifacts.length > 0);
};

/** A follow-up round's ticket: the ticket, then the feedback it addresses. Every prompt of the run reads it. */
export const followUpTicket = async (
  execution: { id: string; parentExecutionId: string | null; createdAt: Date },
  ticket: string,
  ownTests: { status: string; file: string }[] = [],
) => {
  if (!execution.parentExecutionId) return { ticket };
  const feedback = await roundFeedback(execution.id);
  const round = await prisma.execution.count({
    where: { parentExecutionId: execution.parentExecutionId, createdAt: { lte: execution.createdAt } },
  });
  const note = executionPromptFragment("followUp", { round: String(round), ownTests: describeOwnTests(ownTests), feedback: describeFeedback(feedback) });
  return { ticket: `${ticket}\n\n${note}`, followUpPrompt: EXECUTION_PROMPTS.followUp };
};

/** What a round addresses, as the ticket and the pull request are told. */
export const formatFollowUpComment = (round: number, items: Pick<ExecutionFeedback, "source" | "author" | "body" | "requestsChanges">[]) =>
  [
    `**Working on your feedback (round ${round}).** I'll change the pull request's branch and ask you to approve the new diff before pushing it.`,
    // A set: the same check failing on two commits is one line.
    ...new Set(
      items
        .filter((item) => item.requestsChanges)
        .map((item) =>
          item.source === "CI_CHECK"
            ? `- The check "${item.author}" failed on the latest commit.`
            : `- ${origin(item)}: ${item.body.trim().split("\n")[0].slice(0, 200) || "line comments"}`,
        ),
    ),
  ].join("\n");

/**
 * Starts a round for every pull request that has feedback asking for changes
 * and no round running. The pull request must still be open on the host:
 * feedback can be stored before the poll that records a merge.
 */
export const startFollowUps = async () => {
  const roots = await prisma.execution.findMany({
    where: {
      parentExecutionId: null,
      status: "COMPLETED",
      branchName: { not: null },
      artifacts: { some: { type: "PULL_REQUEST" } },
      events: { none: { type: OUTCOME_EVENT } },
      feedback: { some: { addressedByExecutionId: null, requestsChanges: true } },
      followUps: { none: { status: { notIn: ENDED } } },
    },
    include: {
      repository: true,
      workItem: true,
      artifacts: { where: { type: "PULL_REQUEST" }, orderBy: { createdAt: "asc" }, take: 1 },
      feedback: { where: { addressedByExecutionId: null }, orderBy: { writtenAt: "asc" }, take: MAX_FEEDBACK_PER_ROUND },
    },
  });
  let started = 0;
  for (const root of roots)
    try {
      const number = (root.artifacts[0]?.metadata as { number?: unknown } | null)?.number;
      if (typeof number !== "number" || !root.branchName) continue;
      const sourceControl = await sourceControlFor(root.repository);
      if ((await sourceControl.pullRequestOutcome(number)).state !== "OPEN") continue;
      // Every round that ran counts, failed or blocked ones too (each was paid for); a canceled one does not.
      const rounds = await prisma.execution.count({ where: { parentExecutionId: root.id, status: { not: "CANCELED" } } });
      const limit = (root.repository.executionPolicy as { maxFollowUpRounds?: number } | null)?.maxFollowUpRounds ?? DEFAULT_MAX_FOLLOW_UP_ROUNDS;
      if (rounds >= limit) {
        // Once per count of rounds: raising the limit and using it up again hands back again.
        const told = await prisma.executionEvent.count({ where: { executionId: root.id, type: ROUND_LIMIT_EVENT, payload: { path: ["rounds"], equals: rounds } } });
        if (told) continue;
        await graphEvent(root.id, ROUND_LIMIT_EVENT, { rounds, limit });
        const note = formatRoundLimitComment(rounds);
        await commentOnWorkItem(root.projectId, root.workItem, note).catch((error) =>
          console.error(`Round limit note on the ticket failed for ${root.id}: ${describeError(error)}`),
        );
        await sourceControl.commentOnPullRequest(number, note).catch((error) =>
          console.error(`Round limit note on the pull request failed for ${root.id}: ${describeError(error)}`),
        );
        continue;
      }
      const head = await sourceControl.branchHead(root.branchName);
      const created = await createFollowUpExecution(root, root.feedback.map((item) => item.id), head);
      if (!created) continue;
      started++;
      const note = formatFollowUpComment(created.round, root.feedback);
      await commentOnWorkItem(root.projectId, root.workItem, note).catch((error) =>
        console.error(`Follow-up note on the ticket failed for ${created.execution.id}: ${describeError(error)}`),
      );
      await sourceControl.commentOnPullRequest(number, note).catch((error) =>
        console.error(`Follow-up note on the pull request failed for ${created.execution.id}: ${describeError(error)}`),
      );
    } catch (error) {
      console.error(`Follow-up for execution ${root.id} failed to start: ${describeError(error)}`);
    }
  return started;
};
