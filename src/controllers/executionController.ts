import { Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { config } from "../config";
import prisma from "../db";
import { AppError } from "../errors/AppError";
import { asyncHandler } from "../middleware/asyncHandler";
import { parseVerificationConfig } from "../services/toolchain";
import { StoredProposal } from "../services/toolchain/discovery";
import {
  createExecution,
  decideApproval,
  requestPlanRevision,
  submitPlan,
} from "../services/executionService";
import { syncIntegrationConnection } from "../services/ingestionService";
import {
  redactIntegration,
  sealIntegrationConfig,
} from "../services/integrationConfigService";

export const createRepository = asyncHandler(
  async (req: Request, res: Response) => {
    const {
      projectId,
      owner,
      name,
      defaultBranch,
      githubInstallationId,
      verificationConfig,
      executionPolicy,
    } = req.body;
    const repository = await prisma.repository.create({
      data: {
        projectId,
        owner,
        name,
        defaultBranch,
        githubInstallationId,
        verificationConfig,
        executionPolicy,
      },
    });
    res.status(201).json(repository);
  },
);
/** Sets a repository's environment or policy; later executions use it. */
export const updateRepository = asyncHandler(
  async (req: Request, res: Response) => {
    const { verificationConfig, executionPolicy } = req.body;
    res.json(
      await prisma.repository.update({
        where: { id: req.params.id },
        data: { verificationConfig, executionPolicy },
      }),
    );
  },
);
/**
 * Approves the environment discovery proposed and a run proved: it becomes
 * the repository's configured environment, so later runs use its checks as
 * fixed checks. The hash must match, so what is approved is what was proved.
 */
export const approveEnvironment = asyncHandler(
  async (req: Request, res: Response) => {
    const repository = await prisma.repository.findUnique({ where: { id: req.params.id } });
    if (!repository) throw AppError.notFound("Repository not found");
    const proposal = repository.environmentProposal as unknown as StoredProposal | null;
    if (!proposal) throw AppError.conflict("This repository has no proposed environment to approve");
    if (proposal.hash !== req.body.proposalHash)
      throw AppError.conflict("The proposed environment has changed; review the current proposal and approve its hash");

    const current = parseVerificationConfig(repository.verificationConfig);
    const verificationConfig = parseVerificationConfig({
      ...current,
      // Proposed variables add to configured ones, as they did when the proposal was proved.
      toolchain: {
        ...current.toolchain,
        ...proposal.toolchain,
        ...(proposal.toolchain.env ? { env: { ...current.toolchain?.env, ...proposal.toolchain.env } } : {}),
      },
    });
    // Only if nothing changed the repository since it was read.
    const { count } = await prisma.repository.updateMany({
      where: { id: repository.id, updatedAt: repository.updatedAt },
      data: {
        verificationConfig: verificationConfig as Prisma.InputJsonObject,
        environmentProposal: Prisma.DbNull,
      },
    });
    if (!count) throw AppError.conflict("The repository changed while approving; try again");
    res.json(await prisma.repository.findUniqueOrThrow({ where: { id: repository.id } }));
  },
);
export const listRepositories = asyncHandler(
  async (req: Request, res: Response) => {
    res.json(
      await prisma.repository.findMany({
        where: { projectId: req.query.projectId as string | undefined },
        take: 100,
      }),
    );
  },
);
export const createIntegration = asyncHandler(
  async (req: Request, res: Response) => {
    const { config: secretConfig, projectId, type, name } = req.body;
    const connection = await prisma.integrationConnection.create({
      data: {
        projectId,
        type,
        name,
        encryptedConfig: sealIntegrationConfig(secretConfig),
      },
    });
    res.status(201).json(redactIntegration(connection));
  },
);
export const listIntegrations = asyncHandler(
  async (req: Request, res: Response) => {
    const rows = await prisma.integrationConnection.findMany({
      where: { projectId: req.query.projectId as string | undefined },
      take: 100,
    });
    res.json(rows.map(redactIntegration));
  },
);
export const syncIntegration = asyncHandler(
  async (req: Request, res: Response) => {
    res.json(await syncIntegrationConnection(req.params.id));
  },
);
export const listWorkItems = asyncHandler(
  async (req: Request, res: Response) => {
    res.json(
      await prisma.workItem.findMany({
        where: { projectId: req.query.projectId as string | undefined },
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
    );
  },
);
export const getWorkItem = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await prisma.workItem.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { executions: true },
    }),
  );
});
export const startExecution = asyncHandler(
  async (req: Request, res: Response) => {
    const workItem = await prisma.workItem.findUniqueOrThrow({
      where: { id: req.body.workItemId },
    });
    const execution = await createExecution({
      projectId: req.body.projectId,
      repositoryId: req.body.repositoryId,
      workItemId: workItem.id,
      revisionHash: workItem.revisionHash ?? workItem.updatedAt.toISOString(),
    });
    res.status(202).json(execution);
  },
);
export const listExecutions = asyncHandler(
  async (req: Request, res: Response) => {
    res.json(
      await prisma.execution.findMany({
        where: { projectId: req.query.projectId as string | undefined },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    );
  },
);
export const getExecution = asyncHandler(
  async (req: Request, res: Response) => {
    const [execution, usage] = await Promise.all([
      prisma.execution.findUniqueOrThrow({
        where: { id: req.params.id },
        include: {
          plans: {
            include: {
              tasks: { include: { dependencies: true, attempts: true } },
            },
          },
          approvals: true,
          artifacts: true,
          events: { orderBy: { sequence: "asc" } },
        },
      }),
      // Every model call the execution made, per model, so its cost can be worked out.
      prisma.llmUsage.groupBy({
        by: ["provider", "model"],
        where: { executionId: req.params.id },
        _count: { _all: true },
        _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, reasoningTokens: true },
      }),
    ]);
    res.json({
      ...execution,
      usage: usage.map((row) => ({
        provider: row.provider,
        model: row.model,
        calls: row._count._all,
        inputTokens: row._sum.inputTokens ?? 0,
        cachedInputTokens: row._sum.cachedInputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        reasoningTokens: row._sum.reasoningTokens ?? 0,
      })),
    });
  },
);
export const createPlan = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(await submitPlan(req.params.id, req.body));
});
/** Approve, reject, or (plan only) answer with feedback so the agent revises the plan. */
export const approve = asyncHandler(async (req: Request, res: Response) => {
  if (req.body.revise) {
    if (req.params.type !== "plan") throw AppError.badRequest("Only a plan can be revised");
    res.json(await requestPlanRevision(req.params.id, req.body.snapshotHash, config.apiAuthActor, req.body.comment));
    return;
  }
  res.json(
    await decideApproval(
      req.params.id,
      req.params.type.toUpperCase() as "PLAN" | "PUBLISH",
      req.body.approved,
      req.body.snapshotHash,
      config.apiAuthActor,
      req.body.comment,
    ),
  );
});
