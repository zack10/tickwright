import { ExecutionStatus, Prisma } from "@prisma/client";
import fs from "node:fs/promises";
import { z } from "zod";
import { config } from "../config";
import prisma from "../db";
import {
  createDraftPullRequest,
  findOpenPullRequest,
  getBaseSha,
  getInstallationToken,
} from "../integrations/githubApp";
import { commentOnWorkItem } from "./ingestionService";
import { NonRetryableError, describeError } from "../utils/safeError";
import { discardExecutionRun, runExecutionGraph } from "./agentGraph/executionGraph";
import { planExecution } from "./agentGraph/planning";
import { hashSnapshot } from "./executionService";
import { formatPlanComment, formatPublishComment } from "./ticketConversation";
import rabbitMQService from "./rabbitMQService";
import { describeVerification, publishApprovedDiff } from "./workspaceService";

const TERMINAL: ExecutionStatus[] = ["COMPLETED", "BLOCKED", "FAILED", "CANCELED"];
const RUN_STATES: ExecutionStatus[] = ["RUNNING", "VERIFYING"];

/** Comments on the source ticket in whichever tracker it came from. Never throws. */
const notifyTracker = async (executionId: string, text: string) => {
  try {
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
      include: { workItem: true },
    });
    if (execution)
      await commentOnWorkItem(execution.projectId, execution.workItem, text);
  } catch (error) {
    console.error(
      `Tracker notification failed for execution ${executionId}: ${describeError(error)}`,
    );
  }
};

const appendEvent = async (
  executionId: string,
  type: string,
  payload: Record<string, unknown>,
) => {
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: executionId },
    select: { correlationId: true },
  });
  const latest = await prisma.executionEvent.findFirst({
    where: { executionId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  await prisma.executionEvent.create({
    data: {
      executionId,
      sequence: (latest?.sequence ?? 0) + 1,
      type,
      payload: payload as Prisma.InputJsonObject,
      correlationId: execution.correlationId,
    },
  });
};

/** Moves a non-terminal execution to FAILED. Safe to call more than once. */
export const markExecutionFailed = async (
  executionId: string,
  stage: string,
  error: unknown,
) => {
  const reason = describeError(error).slice(0, 4000);
  const result = await prisma.execution.updateMany({
    where: { id: executionId, status: { notIn: TERMINAL } },
    data: {
      status: "FAILED",
      lastError: `${stage}: ${reason}`,
      leaseUntil: null,
      completedAt: new Date(),
    },
  });
  if (result.count === 0) return;
  // No retry is left to resume the run: drop its saved steps and workspace.
  await discardExecutionRun(executionId).catch((cleanupError) =>
    console.error(`Cleanup failed for ${executionId}: ${describeError(cleanupError)}`),
  );
  await appendEvent(executionId, "EXECUTION_FAILED", { stage, reason });
  await notifyTracker(
    executionId,
    `Execution ${executionId} failed during ${stage}. Review the execution evidence.`,
  );
};

const executionMessage = z.object({
  messageId: z.string().min(1),
  executionId: z.string().uuid(),
});

const consumeOnce = async (
  consumer: string,
  raw: unknown,
  handler: (executionId: string) => Promise<void>,
) => {
  const parsed = executionMessage.safeParse(raw);
  if (!parsed.success) throw new NonRetryableError("Invalid execution message");
  const { messageId, executionId } = parsed.data;
  if (await prisma.inboxReceipt.findUnique({ where: { messageId } })) return;
  await handler(executionId);
  await prisma.inboxReceipt.create({ data: { messageId, consumer } });
};

const plan = async (executionId: string) => {
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: executionId },
    include: { workItem: true },
  });
  // PLANNING is resumable: a failure after the status change must not strand it.
  if (execution.status !== "INGESTED" && execution.status !== "PLANNING")
    return;
  if (execution.status === "INGESTED")
    await prisma.execution.updateMany({
      where: { id: executionId, status: "INGESTED" },
      data: { status: "PLANNING" },
    });
  const outcome = await planExecution(executionId);
  if (outcome.status === "declined") {
    // Stopped before anyone is asked: there is nothing to approve.
    const reason = `The agent declined the ticket: ${outcome.reason}`;
    const blocked = await prisma.execution.updateMany({
      where: { id: executionId, status: "PLANNING" },
      data: { status: "BLOCKED", lastError: reason, completedAt: new Date() },
    });
    if (blocked.count) await notifyTracker(executionId, `${reason}\n\nEdit the ticket to start again.`);
    return;
  }
  await notifyTracker(executionId, formatPlanComment(outcome.plan, outcome.version));
};

const leaseExpiry = () => new Date(Date.now() + config.executionLeaseMs);

/**
 * Claims a QUEUED execution (or one whose run lease expired after a crash)
 * so only one worker runs it at a time.
 */
const claimRun = async (executionId: string) => {
  const claimed = await prisma.execution.updateMany({
    where: {
      id: executionId,
      OR: [
        { status: "QUEUED" },
        { status: { in: RUN_STATES }, leaseUntil: { lt: new Date() } },
      ],
    },
    data: { status: "RUNNING", leaseUntil: leaseExpiry() },
  });
  return claimed.count === 1;
};

const run = async (executionId: string) => {
  if (!(await claimRun(executionId))) return;

  const heartbeat = setInterval(() => {
    prisma.execution
      .updateMany({
        where: { id: executionId, status: { in: RUN_STATES } },
        data: { leaseUntil: leaseExpiry() },
      })
      .catch((error) =>
        console.error(
          `Lease renewal failed for ${executionId}: ${describeError(error)}`,
        ),
      );
  }, Math.max(1000, Math.floor(config.executionLeaseMs / 3)));

  try {
    await runExecutionGraph(executionId);
  } catch (error) {
    // Release the claim so the bounded consumer retry can run it again.
    await prisma.execution.updateMany({
      where: { id: executionId, status: { in: RUN_STATES } },
      data: { status: "QUEUED", leaseUntil: null, lastError: describeError(error) },
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }

  await prisma.execution.updateMany({
    where: { id: executionId },
    data: { leaseUntil: null },
  });
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    select: { status: true, lastError: true },
  });
  if (execution?.status === "BLOCKED")
    await notifyTracker(
      executionId,
      `Execution ${executionId} is blocked: ${(execution.lastError ?? "").slice(0, 1500) || "see the execution evidence"}`,
    );
  if (execution?.status === "AWAITING_PUBLISH_APPROVAL") {
    // What changed and what the checks and the reviewer found, where the approver decides.
    const diff = await prisma.artifact.findFirst({
      where: { executionId, type: "DIFF" },
      orderBy: { createdAt: "desc" },
      select: { metadata: true, storagePath: true },
    });
    const files = diff
      ? [...new Set([...(await fs.readFile(diff.storagePath, "utf8")).matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((match) => match[1]))]
      : [];
    await notifyTracker(executionId, formatPublishComment(files, describeVerification(diff?.metadata)));
  }
};

const publish = async (executionId: string) => {
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: executionId },
    include: {
      repository: true,
      workItem: true,
      artifacts: {
        where: { type: { in: ["DIFF", "PULL_REQUEST"] } },
        orderBy: { createdAt: "desc" },
      },
      approvals: {
        where: { type: "PUBLISH", status: "APPROVED" },
        orderBy: { decidedAt: "desc" },
        take: 1,
      },
    },
  });
  if (execution.status === "COMPLETED") return;
  if (execution.status !== "PUBLISHING")
    throw new NonRetryableError(
      `Execution cannot publish from ${execution.status}`,
    );

  const { repository } = execution;
  const branch = `agent/${execution.id}`;
  const existingPr = execution.artifacts.find(
    (artifact) => artifact.type === "PULL_REQUEST",
  );
  if (!existingPr) {
    const diffArtifact = execution.artifacts.find(
      (artifact) => artifact.type === "DIFF",
    );
    const approval = execution.approvals[0];
    if (!diffArtifact || !approval)
      throw new NonRetryableError("No approved diff artifact to publish");
    if (approval.snapshotHash !== diffArtifact.sha256)
      throw new NonRetryableError(
        "Approved diff snapshot does not match current artifact",
      );
    // Publish exactly the bytes that were approved, never the live workspace.
    const diff = await fs.readFile(diffArtifact.storagePath, "utf8");
    if (hashSnapshot(diff) !== approval.snapshotHash)
      throw new NonRetryableError(
        "Stored diff artifact does not match the approved snapshot",
      );
    if (!execution.baseSha)
      throw new NonRetryableError("Execution has no recorded base SHA");
    const currentBaseSha = await getBaseSha(
      repository.githubInstallationId,
      repository.owner,
      repository.name,
      repository.defaultBranch,
    );
    if (currentBaseSha !== execution.baseSha)
      throw new NonRetryableError(
        "Repository base branch changed after execution; replan is required",
      );

    const pullRequestInput = {
      installationId: repository.githubInstallationId,
      owner: repository.owner,
      repo: repository.name,
      head: branch,
    };
    let pr = await findOpenPullRequest(pullRequestInput);
    if (!pr) {
      await publishApprovedDiff({
        executionId: execution.id,
        diff,
        branch,
        baseSha: execution.baseSha,
        owner: repository.owner,
        repo: repository.name,
        token: await getInstallationToken(repository.githubInstallationId),
      });
      pr = await createDraftPullRequest({
        ...pullRequestInput,
        title: execution.workItem.title,
        base: repository.defaultBranch,
        body: `Automated draft for ${execution.workItem.sourceUrl ?? execution.workItem.id}\n\nExecution: ${execution.id}\n\n${describeVerification(diffArtifact.metadata)}\n\nHuman review is required.`,
      });
    }
    await prisma.artifact.create({
      data: {
        executionId,
        type: "PULL_REQUEST",
        name: `PR #${pr.number}`,
        storagePath: pr.html_url,
        sha256: hashSnapshot(pr),
        metadata: { number: pr.number, html_url: pr.html_url },
      },
    });
  }

  const prUrl =
    existingPr?.storagePath ??
    (
      await prisma.artifact.findFirstOrThrow({
        where: { executionId, type: "PULL_REQUEST" },
        orderBy: { createdAt: "desc" },
      })
    ).storagePath;
  await prisma.execution.update({
    where: { id: executionId },
    data: { status: "COMPLETED", branchName: branch, completedAt: new Date() },
  });
  await notifyTracker(
    executionId,
    `Draft pull request created: ${prUrl}\nExecution: ${executionId}`,
  );
};

const failOnExhausted = (stage: string) => async (raw: unknown, error: unknown) => {
  const parsed = executionMessage.safeParse(raw);
  if (parsed.success)
    await markExecutionFailed(parsed.data.executionId, stage, error);
};

let recoveryTimer: NodeJS.Timeout | null = null;
let recovering = false;

/** Requeues runs whose worker died (lease expired without renewal). */
export const recoverStalledExecutions = async () => {
  if (recovering) return;
  recovering = true;
  try {
    const stalled = await prisma.execution.findMany({
      where: { status: { in: RUN_STATES }, leaseUntil: { lt: new Date() } },
      select: { id: true, correlationId: true },
      take: 50,
    });
    for (const execution of stalled)
      await prisma.$transaction(async (tx) => {
        const reset = await tx.execution.updateMany({
          where: {
            id: execution.id,
            status: { in: RUN_STATES },
            leaseUntil: { lt: new Date() },
          },
          data: {
            status: "QUEUED",
            leaseUntil: null,
            lastError: "Execution lease expired",
          },
        });
        if (reset.count === 1)
          await tx.outboxEvent.create({
            data: {
              topic: "execution.run",
              aggregateId: execution.id,
              payload: {
                executionId: execution.id,
                correlationId: execution.correlationId,
              },
            },
          });
      });
  } finally {
    recovering = false;
  }
};

export const startExecutionWorkers = async () => {
  await rabbitMQService.subscribe(
    "execution_plan",
    "execution.plan",
    (raw) => consumeOnce("planner", raw, plan),
    { onExhausted: failOnExhausted("planning"), prefetch: config.executionPlanConcurrency },
  );
  await rabbitMQService.subscribe(
    "execution_run",
    "execution.run",
    (raw) => consumeOnce("runner", raw, run),
    { onExhausted: failOnExhausted("run"), prefetch: config.executionRunConcurrency },
  );
  await rabbitMQService.subscribe(
    "execution_publish",
    "execution.publish",
    (raw) => consumeOnce("publisher", raw, publish),
    { onExhausted: failOnExhausted("publish") },
  );
  recoveryTimer = setInterval(() => {
    recoverStalledExecutions().catch((error) =>
      console.error(`Execution recovery sweep failed: ${describeError(error)}`),
    );
  }, 60_000);
  recoveryTimer.unref();
};

export const stopExecutionWorkers = () => {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
};
