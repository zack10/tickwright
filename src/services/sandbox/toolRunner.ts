import { Prisma } from "@prisma/client";
import prisma from "../../db";
import { RepositoryPolicy } from "../agentGraph/repoPolicy";
import { ToolCall, ToolDefinition } from "../llm/types";
import { Toolchain, isTestFile, selectChecks } from "../toolchain";
import { changedFiles, execInSandbox, keepOutputOutOfDiffs, trackedFiles, workspacePath } from "../workspaceService";
import { CHECK_TIMEOUT_MS, ToolContext, ToolOutcome, ToolStatus, executeTool } from "./tools";

// Stored output is capped; the full output already went to the model.
const MAX_STORED_OUTPUT_CHARS = 10_000;

/** Where tool calls are recorded; the Prisma version writes the ToolCall table. */
export interface ToolCallRecorder {
  create(data: { name: string; input: unknown; policy: unknown }): Promise<string>;
  update(
    id: string,
    data: {
      status: "RUNNING" | ToolStatus;
      output?: unknown;
      policy?: unknown;
      startedAt?: Date;
      completedAt?: Date;
    },
  ): Promise<void>;
}

/** Postgres jsonb rejects \u0000, which model arguments and tool output can contain. */
export const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "string" ? item.replaceAll("\u0000", "\uFFFD") : item)),
  ) as Prisma.InputJsonValue;

export const prismaToolCallRecorder = (attemptId: string): ToolCallRecorder => ({
  async create({ name, input, policy }) {
    const row = await prisma.toolCall.create({
      data: { attemptId, name, input: json(input), policy: json(policy) },
    });
    return row.id;
  },
  async update(id, { output, policy, ...rest }) {
    await prisma.toolCall.update({
      where: { id },
      data: {
        ...rest,
        ...(output === undefined ? {} : { output: json(output) }),
        ...(policy === undefined ? {} : { policy: json(policy) }),
      },
    });
  },
});

/**
 * Runs one tool call and records it: REQUESTED with the policy in force,
 * RUNNING, then COMPLETED, DENIED or FAILED with its (capped) output.
 */
export const runRecordedTool = async (
  ctx: ToolContext,
  call: ToolCall,
  recorder: ToolCallRecorder,
  tools?: ToolDefinition[],
): Promise<ToolOutcome> => {
  const policy = { protectedPaths: ctx.protectedPaths, checkScripts: ctx.checkScripts };
  const id = await recorder.create({ name: call.name, input: call.arguments, policy });
  await recorder.update(id, { status: "RUNNING", startedAt: new Date() });
  const outcome = await executeTool(ctx, call.name, call.arguments, tools);
  await recorder.update(id, {
    status: outcome.status,
    output: {
      text: outcome.output.slice(0, MAX_STORED_OUTPUT_CHARS),
      truncated: outcome.output.length > MAX_STORED_OUTPUT_CHARS,
      ...(outcome.finish ? { finish: outcome.finish } : {}),
      ...(outcome.verdict ? { verdict: outcome.verdict } : {}),
    },
    // Denials record why, so a run can be audited without the transcript.
    ...(outcome.status === "DENIED" ? { policy: { ...policy, denied: outcome.output } } : {}),
    completedAt: new Date(),
  });
  return outcome;
};

/** The tool context for an execution, from its repository's settings and toolchain. */
export const executionToolContext = async (
  executionId: string,
  repository: { executionPolicy: unknown; verificationConfig: unknown },
  toolchain: Toolchain,
  failingBefore: Record<string, string> = {},
): Promise<ToolContext> => {
  const policy = repository.executionPolicy as RepositoryPolicy | null;
  const checks = selectChecks(toolchain, repository.verificationConfig).run;
  const baseFiles = new Set(await trackedFiles(executionId));
  // An attempt that continues from kept changes already passed the gate.
  const newTest = (await changedFiles(executionId)).some((file) => isTestFile(toolchain, file) && !baseFiles.has(file));
  return {
    root: workspacePath(executionId),
    protectedPaths: policy?.protectedPaths ?? toolchain.protectedPaths,
    checkScripts: checks.map((check) => check.name),
    runCheck: (name) => {
      const check = checks.find((candidate) => candidate.name === name);
      if (!check) throw new Error(`Unknown check "${name}"`);
      // What the check writes (build output, caches) is not the agent's change.
      return keepOutputOutOfDiffs(executionId, () => execInSandbox(executionId, check.command, CHECK_TIMEOUT_MS));
    },
    // What the agent's commands write is its change: visible in the diff and policed there.
    runCommand: (command, timeoutMs) => execInSandbox(executionId, ["sh", "-c", command], timeoutMs),
    isTestFile: (file) => isTestFile(toolchain, file),
    isBaseFile: (file) => baseFiles.has(file),
    reproduction: { shown: newTest, newTest },
    limits: { maxOutputChars: policy?.maxToolOutputChars, maxReadLines: policy?.maxReadLines },
    failingBefore,
  };
};
