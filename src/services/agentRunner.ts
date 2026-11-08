import {
  Agent,
  MCPResource,
  Prisma,
  Project,
  Skill,
  Task,
} from "@prisma/client";
import { z } from "zod";
import { config as appConfig } from "../config";
import prisma from "../db";
import { writeGeneratedCode } from "../utils/codeWriter";
import { decrypt } from "../utils/crypto";
import { parseAgentOutput } from "../utils/llmUtils";
import { describeError } from "../utils/safeError";
import { LLMService } from "./llm/LLMService";
import { getProjectContext, updateProjectContext } from "./projectService";
import { buildAgentPrompt } from "./promptBuilder";

const AgentConfigSchema = z
  .object({
    apiKey: z.string().optional(),
  })
  .passthrough();

export interface AgentWithRelations extends Agent {
  skills: Skill[];
  resources: MCPResource[];
}

export interface ProjectWithRelations extends Project {
  agents: Agent[];
}

export interface TaskWithRelations extends Task {
  agent: AgentWithRelations;
  project: ProjectWithRelations | null;
}

const llmService = new LLMService();

const applyContextUpdates = async (
  contextUpdates: string | undefined,
  projectId: string | null,
) => {
  if (!contextUpdates || !projectId) return;
  try {
    const updates = JSON.parse(contextUpdates);
    await updateProjectContext(projectId, {
      contextData: updates as Prisma.JsonObject,
    });
  } catch (error) {
    console.warn(`Failed to apply context updates: ${describeError(error)}`);
  }
};

export const runAgent = async (taskId: string) => {
  const claim = await prisma.task.updateMany({
    where: { id: taskId, status: "PENDING" },
    data: {
      status: "IN_PROGRESS",
      startedAt: new Date(),
      attemptCount: { increment: 1 },
      lastError: null,
    },
  });
  if (claim.count === 0) return false;

  const task = (await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      agent: {
        include: { skills: true, resources: true },
      },
      project: {
        include: { agents: true },
      },
    },
  })) as TaskWithRelations | null;

  if (!task?.agent)
    throw new Error(`Claimed task ${taskId} could not be loaded`);

  try {
    const { agent, project } = task;
    const context = project ||
      (await getProjectContext(agent.projectId || "")) || {
        name: "Unknown Project",
        techStack: null,
        architectureDecisions: null,
        contextData: {},
      };

    const prompt = buildAgentPrompt({ project: context, agent, task });

    // Extract API key from config if available (encrypted)
    let apiKey: string | undefined;
    const config = agent.config ? AgentConfigSchema.parse(agent.config) : null;

    if (config?.apiKey) {
      apiKey = decrypt(config.apiKey);
    }

    const { provider, model } = llmService.resolveModel(agent);
    const rawOutput = await llmService.generateContent(
      provider,
      model,
      prompt,
      apiKey,
      { purpose: "task", taskId },
    );
    const parsed = parseAgentOutput(rawOutput);

    // Write generated code if any
    let writtenFiles: string[] = [];
    if (parsed.actions) {
      writtenFiles = writeGeneratedCode(
        parsed.actions,
        context.name || "Unknown Project",
      );
      if (writtenFiles.length > 0) {
        console.log(
          `Agent ${agent.name} wrote ${writtenFiles.length} files to generated-code/.`,
        );
      }
    }

    await applyContextUpdates(parsed.contextUpdates, task.projectId);

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: parsed.status === "COMPLETED" ? "COMPLETED" : "FAILED",
        completedAt: new Date(),
        result: {
          thinking: parsed.thinking,
          actions: parsed.actions,
          writtenFiles,
          ...(appConfig.storeRawLlmOutput ? { raw: parsed.raw } : {}),
        } as Prisma.JsonObject,
      },
    });
    return true;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`Error running agent execution loop: ${describeError(err)}`);
    throw err;
  }
};
