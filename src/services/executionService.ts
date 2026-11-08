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
        budget: {
          maxAttempts: 3,
          maxChangedFiles: 20,
          maxDurationSeconds: config.executionMaxDurationSeconds,
          maxTokens: config.executionMaxTokens,
        },
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
  });
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
    await tx.execution.update({
      where: { id: executionId },
      data: { status: "AWAITING_PLAN_APPROVAL" },
    });
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
