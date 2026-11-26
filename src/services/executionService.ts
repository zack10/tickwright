import { ApprovalType, ExecutionStatus, Prisma } from "@prisma/client";
import crypto from "crypto";
import { config } from "../config";
import prisma from "../db";
import { AppError } from "../errors/AppError";

const json = (value: unknown) => value as Prisma.InputJsonValue;
export const hashSnapshot = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const event = async (
  tx: Prisma.TransactionClient,
  executionId: string,
  type: string,
  payload: unknown,
  correlationId: string,
) => {
  const latest = await tx.executionEvent.findFirst({
    where: { executionId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  await tx.executionEvent.create({
    data: {
      executionId,
      sequence: (latest?.sequence ?? 0) + 1,
      type,
      payload: json(payload),
      correlationId,
    },
  });
};

const ENDED: ExecutionStatus[] = ["COMPLETED", "BLOCKED", "FAILED", "CANCELED"];

/**
 * Ends an execution in any state that is not already final. A running step
 * notices it (isCanceled) and stops; what the run left behind is removed by
 * the environment sweep. An eval stopped by hand left runs spending on the
 * server with nobody grading them (2026-11-16).
 */
export const cancelExecution = async (executionId: string, actor: string, reason?: string) =>
  prisma.$transaction(async (tx) => {
    const execution = await tx.execution.findUnique({ where: { id: executionId } });
    if (!execution) throw AppError.notFound("Execution not found");
    const moved = await tx.execution.updateMany({
      where: { id: executionId, status: { notIn: ENDED } },
      data: {
        status: "CANCELED",
        lastError: `Canceled: ${reason ?? "No reason supplied"}`,
        completedAt: new Date(),
        leaseUntil: null,
      },
    });
    if (moved.count !== 1) throw AppError.conflict(`Execution has already ended (${execution.status})`);
    await tx.approval.updateMany({
      where: { executionId, status: "PENDING" },
      data: { status: "REJECTED", actor, comment: "Execution canceled", decidedAt: new Date() },
    });
    await event(tx, executionId, "EXECUTION_CANCELED", { from: execution.status, actor, reason: reason ?? null }, execution.correlationId);
    return tx.execution.findUniqueOrThrow({ where: { id: executionId } });
  });

export const isCanceled = async (executionId: string) =>
  (await prisma.execution.count({ where: { id: executionId, status: "CANCELED" } })) > 0;

/** Thrown inside a run when its execution was canceled: the run stops and is not retried. */
export class ExecutionCanceledError extends Error {
  constructor(executionId: string) {
    super(`Execution ${executionId} was canceled`);
  }
}

const defaultBudget = () => ({
  maxAttempts: 3,
  maxChangedFiles: 20,
  maxDurationSeconds: config.executionMaxDurationSeconds,
  maxTokens: config.executionMaxTokens,
});

export const createExecution = async (input: {
  projectId: string;
  workItemId: string;
  repositoryId: string;
  revisionHash: string;
}) => {
  const idempotencyKey = `${input.workItemId}:${input.revisionHash}`;
  const existing = await prisma.execution.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return existing;
  return prisma.$transaction(async (tx) => {
    const execution = await tx.execution.create({
      data: {
        projectId: input.projectId,
        workItemId: input.workItemId,
        repositoryId: input.repositoryId,
        idempotencyKey,
        correlationId: crypto.randomUUID(),
        budget: defaultBudget(),
      },
    });
    await event(
      tx,
      execution.id,
      "EXECUTION_CREATED",
      { workItemId: input.workItemId },
      execution.correlationId,
    );
    await tx.outboxEvent.create({
      data: {
        topic: "execution.plan",
        aggregateId: execution.id,
        payload: {
          executionId: execution.id,
          correlationId: execution.correlationId,
        },
      },
    });
    return execution;
  }).catch(alreadyCreated(idempotencyKey));
};

/**
 * A follow-up round on the pull request `root` opened: a new execution on the
 * same branch, starting from the branch's head, that addresses `feedbackIds`.
 * Its plan is the root's, approved by the request itself, so it goes straight
 * to the run; the person still approves its diff before anything is pushed.
 * Returns undefined when another poll started this round first.
 */
export const createFollowUpExecution = async (
  root: { id: string; projectId: string; workItemId: string; repositoryId: string; branchName: string | null; correlationId: string },
  feedbackIds: string[],
  headSha: string,
) => {
  if (!root.branchName) throw new Error(`Execution ${root.id} has no published branch`);
  const rootPlan = await prisma.plan.findFirst({
    where: { executionId: root.id, status: "APPROVED" },
    include: { tasks: true },
    orderBy: { version: "desc" },
  });
  const rootTask = rootPlan?.tasks[0];
  if (!rootPlan || !rootTask) throw new Error(`Execution ${root.id} has no approved plan`);
  const round = (await prisma.execution.count({ where: { parentExecutionId: root.id } })) + 1;
  const summary = `Change the open pull request as its feedback asks (follow-up round ${round}); what the ticket requires must still hold.`;
  const snapshotHash = hashSnapshot({ root: root.id, round, feedbackIds, headSha });
  // The round number in the key: two polls starting the same round cannot both succeed.
  const idempotencyKey = `${root.id}:follow-up:${round}`;
  return prisma
    .$transaction(async (tx) => {
      const execution = await tx.execution.create({
        data: {
          projectId: root.projectId,
          workItemId: root.workItemId,
          repositoryId: root.repositoryId,
          parentExecutionId: root.id,
          status: "QUEUED",
          baseSha: headSha,
          branchName: root.branchName,
          idempotencyKey,
          correlationId: crypto.randomUUID(),
          budget: defaultBudget(),
        },
      });
      const plan = await tx.plan.create({
        data: {
          executionId: execution.id,
          version: 1,
          status: "APPROVED",
          summary,
          acceptanceCriteria: json(rootPlan.acceptanceCriteria),
          estimates: { taskCount: 1 },
          snapshotHash,
        },
      });
      await tx.planTask.create({
        data: {
          planId: plan.id,
          key: rootTask.key,
          title: rootTask.title,
          description: rootTask.description,
          type: rootTask.type,
          // The root's examples and requirements still hold; its questions were settled by its approval.
          expectedOutput: json({ ...(rootTask.expectedOutput as Record<string, unknown>), summary, questions: [] }),
        },
      });
      await tx.approval.create({
        data: { executionId: execution.id, type: "PLAN", snapshotHash, status: "APPROVED", actor: "feedback", decidedAt: new Date() },
      });
      const claimed = await tx.executionFeedback.updateMany({
        where: { id: { in: feedbackIds }, executionId: root.id, addressedByExecutionId: null },
        data: { addressedByExecutionId: execution.id },
      });
      if (claimed.count !== feedbackIds.length) throw new FollowUpTakenError();
      await event(tx, execution.id, "FOLLOW_UP_CREATED", { parentExecutionId: root.id, round, feedbackIds, baseSha: headSha }, execution.correlationId);
      await event(tx, root.id, "FOLLOW_UP_STARTED", { executionId: execution.id, round }, root.correlationId);
      await tx.outboxEvent.create({
        data: {
          topic: "execution.run",
          aggregateId: execution.id,
          payload: { executionId: execution.id, correlationId: execution.correlationId },
        },
      });
      return { execution, round };
    })
    .catch((error: unknown) => {
      if (error instanceof FollowUpTakenError) return undefined;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return undefined;
      throw error;
    });
};

/** The feedback was claimed by a round another poll started at the same time. */
class FollowUpTakenError extends Error {}

/**
 * Two syncs of one connection (the tracker poller and POST .../sync) can create the
 * same execution at once; the one that loses returns the winner's instead of a 409
 * (reference eval dayjs-589, DeepSeek x3 node/06-vague-csv-import).
 */
const alreadyCreated = (idempotencyKey: string) => async (error: unknown) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const created = await prisma.execution.findUnique({ where: { idempotencyKey } });
    if (created) return created;
  }
  throw error;
};

export const submitPlan = async (
  executionId: string,
  input: {
    summary: string;
    acceptanceCriteria: unknown[];
    tasks: Array<{
      key: string;
      title: string;
      description: string;
      type?: string;
      dependsOn?: string[];
      /** What the agent wrote for the task (its plan), shown and approved with it. */
      expectedOutput?: unknown;
    }>;
  },
) => {
  const execution = await prisma.execution.findUnique({
    where: { id: executionId },
    include: { plans: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!execution) throw AppError.notFound("Execution not found");
  if (!["INGESTED", "PLANNING"].includes(execution.status))
    throw AppError.conflict(`Cannot plan execution in ${execution.status}`);
  const keys = new Set(input.tasks.map((task) => task.key));
  if (
    keys.size !== input.tasks.length ||
    input.tasks.some((task) =>
      task.dependsOn?.some((dep) => !keys.has(dep) || dep === task.key),
    )
  )
    throw AppError.badRequest("Plan contains invalid task dependencies");
  const snapshotHash = hashSnapshot(input);
  return prisma.$transaction(async (tx) => {
    const plan = await tx.plan.create({
      data: {
        executionId,
        version: (execution.plans[0]?.version ?? 0) + 1,
        status: "PENDING_APPROVAL",
        summary: input.summary,
        acceptanceCriteria: json(input.acceptanceCriteria),
        estimates: { taskCount: input.tasks.length },
        snapshotHash,
      },
    });
    const created = new Map<string, string>();
    for (const task of input.tasks) {
      const row = await tx.planTask.create({
        data: {
          planId: plan.id,
          key: task.key,
          title: task.title,
          description: task.description,
          type: task.type ?? "IMPLEMENT",
          expectedOutput: json(task.expectedOutput ?? {}),
        },
      });
      created.set(task.key, row.id);
    }
    for (const task of input.tasks)
      for (const dependency of task.dependsOn ?? [])
        await tx.planTaskDependency.create({
          data: {
            taskId: created.get(task.key)!,
            dependsOnId: created.get(dependency)!,
          },
        });
    await tx.approval.create({
      data: { executionId, type: "PLAN", snapshotHash },
    });
    // Conditional: a cancel while the plan was being written wins.
    const moved = await tx.execution.updateMany({
      where: { id: executionId, status: { in: ["INGESTED", "PLANNING"] } },
      data: { status: "AWAITING_PLAN_APPROVAL" },
    });
    if (moved.count !== 1) throw new ExecutionCanceledError(executionId);
    await event(
      tx,
      executionId,
      "PLAN_SUBMITTED",
      { planId: plan.id, snapshotHash },
      execution.correlationId,
    );
    return plan;
  });
};

const approvalTransitions: Record<
  ApprovalType,
  { from: ExecutionStatus; to: ExecutionStatus; topic: string }
> = {
  PLAN: {
    from: "AWAITING_PLAN_APPROVAL",
    to: "QUEUED",
    topic: "execution.run",
  },
  PUBLISH: {
    from: "AWAITING_PUBLISH_APPROVAL",
    to: "PUBLISHING",
    topic: "execution.publish",
  },
};

/**
 * A plan approval answered with feedback instead of a decision: the pending
 * plan is superseded and the plan step writes the next version with the
 * feedback. After config.planMaxVersions plans the execution is blocked, so
 * a conversation cannot go on forever.
 */
export const requestPlanRevision = async (
  executionId: string,
  snapshotHash: string,
  actor: string,
  feedback: string,
) =>
  prisma.$transaction(async (tx) => {
    const execution = await tx.execution.findUnique({ where: { id: executionId } });
    if (!execution) throw AppError.notFound("Execution not found");
    if (execution.status !== "AWAITING_PLAN_APPROVAL")
      throw AppError.conflict("Execution is not awaiting plan approval");
    const approval = await tx.approval.findFirst({
      where: { executionId, type: "PLAN", status: "PENDING" },
      orderBy: { requestedAt: "desc" },
    });
    if (!approval) throw AppError.notFound("Pending approval not found");
    if (approval.snapshotHash !== snapshotHash)
      throw AppError.conflict(
        "Snapshot hash does not match the pending approval; review the latest snapshot",
      );
    const versions = await tx.plan.count({ where: { executionId } });
    const revised = versions < config.planMaxVersions;
    const decidedCount = await tx.approval.updateMany({
      where: { id: approval.id, status: "PENDING" },
      data: { status: "REJECTED", actor, comment: feedback, decidedAt: new Date() },
    });
    const moved = await tx.execution.updateMany({
      where: { id: executionId, status: "AWAITING_PLAN_APPROVAL" },
      data: revised
        ? { status: "PLANNING" }
        : {
            status: "BLOCKED",
            lastError: `The plan was revised ${versions} times without being approved (PLAN_MAX_VERSIONS)`,
            completedAt: new Date(),
          },
    });
    if (decidedCount.count !== 1 || moved.count !== 1)
      throw AppError.conflict("Approval was already decided");
    await tx.plan.updateMany({
      where: { executionId, status: "PENDING_APPROVAL" },
      data: { status: "SUPERSEDED" },
    });
    if (revised)
      await tx.outboxEvent.create({
        data: {
          topic: "execution.plan",
          aggregateId: executionId,
          payload: { executionId, correlationId: execution.correlationId },
        },
      });
    await event(tx, executionId, "PLAN_REVISION_REQUESTED", { actor, feedback, revised }, execution.correlationId);
    return { revised };
  });

export const decideApproval = async (
  executionId: string,
  type: ApprovalType,
  approved: boolean,
  snapshotHash: string,
  actor: string,
  comment?: string,
) =>
  prisma.$transaction(async (tx) => {
    const execution = await tx.execution.findUnique({
      where: { id: executionId },
    });
    if (!execution) throw AppError.notFound("Execution not found");
    const transition = approvalTransitions[type];
    if (execution.status !== transition.from)
      throw AppError.conflict(
        `Execution is not awaiting ${type.toLowerCase()} approval`,
      );
    const approval = await tx.approval.findFirst({
      where: { executionId, type, status: "PENDING" },
      orderBy: { requestedAt: "desc" },
    });
    if (!approval) throw AppError.notFound("Pending approval not found");
    if (approval.snapshotHash !== snapshotHash)
      throw AppError.conflict(
        "Snapshot hash does not match the pending approval; review the latest snapshot",
      );
    // Conditional updates so concurrent decisions cannot both succeed.
    const decidedCount = await tx.approval.updateMany({
      where: { id: approval.id, status: "PENDING" },
      data: {
        status: approved ? "APPROVED" : "REJECTED",
        actor,
        comment,
        decidedAt: new Date(),
      },
    });
    const moved = await tx.execution.updateMany({
      where: { id: executionId, status: transition.from },
      data: approved
        ? { status: transition.to }
        : {
            status: "CANCELED",
            lastError: `${type} rejected: ${comment ?? "No reason supplied"}`,
            completedAt: new Date(),
          },
    });
    if (decidedCount.count !== 1 || moved.count !== 1)
      throw AppError.conflict("Approval was already decided");
    const decided = await tx.approval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    if (approved) {
      await tx.outboxEvent.create({
        data: {
          topic: transition.topic,
          aggregateId: executionId,
          payload: { executionId, correlationId: execution.correlationId },
        },
      });
      if (type === "PLAN")
        await tx.plan.updateMany({
          where: { executionId, status: "PENDING_APPROVAL" },
          data: { status: "APPROVED" },
        });
    }
    await event(
      tx,
      executionId,
      approved ? `${type}_APPROVED` : `${type}_REJECTED`,
      { actor, comment },
      execution.correlationId,
    );
    return decided;
  });

/**
 * Rejects a follow-up round's change with feedback, without ending the work
 * on its pull request: the round ends unpublished, the feedback is stored on
 * the root as a request, and everything the round addressed waits again with
 * its answers cleared, so the next poll starts a round with all of it. Before,
 * a rejected round kept a review bot's findings marked handled, so they were
 * never fixed or answered (dynamic-csv PR #38, 2026-11-26).
 */
export const requestChangeRevision = async (
  executionId: string,
  snapshotHash: string,
  actor: string,
  feedback: string,
) =>
  prisma.$transaction(async (tx) => {
    const execution = await tx.execution.findUnique({ where: { id: executionId } });
    if (!execution) throw AppError.notFound("Execution not found");
    if (execution.status !== "AWAITING_PUBLISH_APPROVAL")
      throw AppError.conflict("Execution is not awaiting publish approval");
    // shortcut: a first change has no pull request for a new round to work on, so it can only be rejected; send it back to planning with the feedback when that is built (roadmap, step 10).
    if (!execution.parentExecutionId)
      throw AppError.badRequest("Only a follow-up round's change can be revised; reject it to stop");
    const approval = await tx.approval.findFirst({
      where: { executionId, type: "PUBLISH", status: "PENDING" },
      orderBy: { requestedAt: "desc" },
    });
    if (!approval) throw AppError.notFound("Pending approval not found");
    if (approval.snapshotHash !== snapshotHash)
      throw AppError.conflict(
        "Snapshot hash does not match the pending approval; review the latest snapshot",
      );
    const decidedCount = await tx.approval.updateMany({
      where: { id: approval.id, status: "PENDING" },
      data: { status: "REJECTED", actor, comment: feedback, decidedAt: new Date() },
    });
    // CANCELED, as a rejection was before: it pushed nothing, and maxFollowUpRounds does not count it.
    const moved = await tx.execution.updateMany({
      where: { id: executionId, status: "AWAITING_PUBLISH_APPROVAL" },
      data: { status: "CANCELED", lastError: `PUBLISH rejected with feedback for a new round: ${feedback}`, completedAt: new Date() },
    });
    if (decidedCount.count !== 1 || moved.count !== 1)
      throw AppError.conflict("Approval was already decided");
    const released = await tx.executionFeedback.updateMany({
      where: { addressedByExecutionId: executionId },
      data: { addressedByExecutionId: null, verdict: null, verdictNote: null, repliedAt: null },
    });
    await tx.executionFeedback.create({
      data: {
        executionId: execution.parentExecutionId,
        source: "TICKET_REPLY",
        externalId: `publish-rejection:${approval.id}`,
        author: actor.replace(/^[a-z]+:/, ""),
        body: feedback,
        requestsChanges: true,
        writtenAt: new Date(),
      },
    });
    await event(tx, executionId, "CHANGE_REVISION_REQUESTED", { actor, feedback, released: released.count }, execution.correlationId);
    return { revised: true };
  });
