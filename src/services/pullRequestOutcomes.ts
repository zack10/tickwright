import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config";
import prisma, { json } from "../db";
import { sourceControlFor } from "../integrations/sourceControl";
import { describeError } from "../utils/safeError";
import { hashSnapshot } from "./executionService";
import { collectCheckFeedback, collectReviewFeedback } from "./feedbackIntake";
import { handBackConflict, retryFindingReplies, startFollowUps } from "./followUps";

export const OUTCOME_EVENT = "PULL_REQUEST_OUTCOME";
// shortcut: PRs left open longer than this are never recorded; raise it if teams review that slowly.
const WATCH_DAYS = 90;
const MAX_LISTED_FILES = 50;

/**
 * Each file's added and removed lines. Hunk headers, index lines and
 * context differ between our git diff and a host's rendering of the same
 * change, so only what changed is compared.
 */
export const changedLines = (diff: string) => {
  const files = new Map<string, string[]>();
  let lines: string[] | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      lines = [];
      files.set(header[1], lines);
    } else if (!lines || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    // Binary patches are rendered differently by each tool; that the file changed is what counts.
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") lines.push("<binary>");
    else if (line.startsWith("+") || line.startsWith("-")) lines.push(line);
  }
  return files;
};

/** The files whose changes differ between what was published and what was merged. */
export const filesChangedByPerson = (published: string, merged: string) => {
  const before = changedLines(published);
  const after = changedLines(merged);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => (before.get(file) ?? []).join("\n") !== (after.get(file) ?? []).join("\n"))
    .sort();
};

/** Records what happened to the agent's pull requests that were merged or closed since the last check. */
export const recordPullRequestOutcomes = async () => {
  const executions = await prisma.execution.findMany({
    where: {
      // A follow-up round shares its root's pull request; the root records it.
      parentExecutionId: null,
      status: "COMPLETED",
      completedAt: { gte: new Date(Date.now() - WATCH_DAYS * 86_400_000) },
      artifacts: { some: { type: "PULL_REQUEST" } },
      events: { none: { type: OUTCOME_EVENT } },
    },
    include: {
      repository: true,
      workItem: true,
      artifacts: { where: { type: { in: ["PULL_REQUEST", "DIFF"] } }, orderBy: { createdAt: "desc" } },
      // Rounds that pushed a commit; one that only answered findings changed nothing.
      _count: { select: { followUps: { where: { status: "COMPLETED", artifacts: { some: { type: "PULL_REQUEST" } } } } } },
    },
    orderBy: { completedAt: "asc" },
    take: 50,
  });
  for (const execution of executions)
    try {
      const pr = execution.artifacts.find((artifact) => artifact.type === "PULL_REQUEST");
      const number = (pr?.metadata as { number?: unknown } | null)?.number;
      if (typeof number !== "number") continue;
      const sourceControl = await sourceControlFor(execution.repository);
      const outcome = await sourceControl.pullRequestOutcome(number);
      if (outcome.state === "OPEN") {
        await collectReviewFeedback(execution, sourceControl, number);
        if (execution.branchName) await collectCheckFeedback(execution, sourceControl, await sourceControl.branchHead(execution.branchName));
        if (outcome.conflict) await handBackConflict(execution, sourceControl, number, outcome.conflict);
        await retryFindingReplies(execution.id, sourceControl, number);
        continue;
      }

      // The newest DIFF is the one publish approved and pushed.
      const published = execution.artifacts.find((artifact) => artifact.type === "DIFF");
      const publishedDiff = published ? await fs.readFile(published.storagePath, "utf8").catch(() => undefined) : undefined;
      const followUpRounds = execution._count.followUps;
      // shortcut: after follow-up commits the published change is several diffs on moving bases, so it is not compared; combine them with git to compare.
      const personChanged =
        outcome.diff !== undefined && publishedDiff !== undefined && !followUpRounds ? filesChangedByPerson(publishedDiff, outcome.diff) : undefined;
      let mergedPath: string | undefined;
      if (outcome.diff !== undefined) {
        await fs.mkdir(config.artifactRoot, { recursive: true });
        mergedPath = path.resolve(config.artifactRoot, `${execution.id}.merged.diff`);
        await fs.writeFile(mergedPath, outcome.diff, "utf8");
      }
      const payload = {
        pullRequest: number,
        state: outcome.state,
        closedAt: outcome.closedAt?.toISOString(),
        // null: merged, but the merged or published diff could not be read, so it is unknown.
        mergedAsWritten: outcome.state === "MERGED" ? (personChanged ? personChanged.length === 0 : null) : false,
        filesChangedByPerson: personChanged?.slice(0, MAX_LISTED_FILES),
        filesChangedByPersonCount: personChanged?.length,
        followUpRounds,
      };
      await prisma.$transaction(async (tx) => {
        if (mergedPath && outcome.diff !== undefined)
          await tx.artifact.create({
            data: {
              executionId: execution.id,
              type: "MERGED_DIFF",
              name: `PR #${number} as merged`,
              storagePath: mergedPath,
              sha256: hashSnapshot(outcome.diff),
              metadata: { pullRequest: number },
            },
          });
        const latest = await tx.executionEvent.findFirst({
          where: { executionId: execution.id },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        await tx.executionEvent.create({
          data: {
            executionId: execution.id,
            sequence: (latest?.sequence ?? 0) + 1,
            type: OUTCOME_EVENT,
            payload: json(payload),
            correlationId: execution.correlationId,
          },
        });
      });
    } catch (error) {
      console.error(`Pull request outcome check failed for execution ${execution.id}: ${describeError(error)}`);
    }
  // After the outcomes, so a PR merged since the last poll gets no round.
  await startFollowUps();
};

let timer: NodeJS.Timeout | null = null;
let checking = false;
const tick = async () => {
  if (checking) return;
  checking = true;
  try {
    await recordPullRequestOutcomes();
  } catch (error) {
    // A DB outage must not become an unhandled rejection (process exit).
    console.error(`Pull request outcome polling failed: ${describeError(error)}`);
  } finally {
    checking = false;
  }
};
export const startPullRequestOutcomePolling = () => {
  void tick();
  timer = setInterval(() => void tick(), config.pullRequestPollIntervalMs);
  timer.unref();
};
export const stopPullRequestOutcomePolling = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
