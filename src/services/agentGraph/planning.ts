import { Approval, Plan, PlanTask } from "@prisma/client";
import { config } from "../../config";
import prisma from "../../db";
import { getBaseSha, getInstallationToken } from "../../integrations/githubApp";
import { renderExecutionPrompt } from "../../prompts";
import { NonRetryableError } from "../../utils/safeError";
import { submitPlan } from "../executionService";
import { ToolContext } from "../sandbox/tools";
import { PlanVerification, describeEnvironment, fsRepoFiles, isTestFile, planVerification, resolveToolchain, selectChecks } from "../toolchain";
import { cloneGithubWorkspace, removeWorkspace, workspacePath } from "../workspaceService";
import { CallContext, askAgent, askAgentWithTools, executionTokensUsed, graphEvent, parseJsonRecord, resolveAgentCalls } from "./agentCalls";
import { PLAN_MAX_TOKENS, runPlanner } from "./planner";
import { collectRepoContext } from "./repoContext";
import { RepositoryPolicy } from "./repoPolicy";

/** The agent's plan as the person approves it and the run follows it. */
export interface AgentPlan {
  summary: string;
  /** Concrete "given ..., the result is ..." examples: how the person checks the reading. */
  expectedBehaviour: string[];
  /** Other readings of the ticket, each with the result it would give instead. */
  questions: string[];
  filesToEdit: string[];
  risk: string;
  testStrategy: string[];
}

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];

/** The plan from the model's reply; missing parts stay empty rather than invented. */
export const planFromReply = (parsed: Record<string, unknown>, title: string): AgentPlan => ({
  summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : `Investigate and change: ${title}`,
  expectedBehaviour: strings(parsed.expectedBehaviour),
  questions: strings(parsed.questions),
  filesToEdit: strings(parsed.filesToEdit),
  risk: typeof parsed.risk === "string" && ["low", "medium", "high"].includes(parsed.risk) ? parsed.risk : "unknown",
  testStrategy: strings(parsed.testStrategy),
});

/** A stored plan as the agent wrote it, or, for one submitted through the API, its summary and criteria. */
export const storedPlan = (plan: Plan & { tasks: PlanTask[] }): AgentPlan => {
  const written = plan.tasks[0]?.expectedOutput as Partial<AgentPlan> | null;
  return {
    summary: plan.summary,
    expectedBehaviour: strings(written?.expectedBehaviour ?? plan.acceptanceCriteria),
    questions: strings(written?.questions),
    filesToEdit: strings(written?.filesToEdit),
    risk: written?.risk ?? "unknown",
    testStrategy: strings(written?.testStrategy),
  };
};

/** Earlier plans of the execution with the feedback each got, for the next revision. */
export const describeRevisions = (plans: Array<Plan & { tasks: PlanTask[] }>, approvals: Approval[]) =>
  plans
    .map((plan) => {
      const decision = approvals.find((approval) => approval.snapshotHash === plan.snapshotHash);
      const { summary, expectedBehaviour } = storedPlan(plan);
      return [
        `Plan version ${plan.version}: ${summary}`,
        ...expectedBehaviour.map((example) => `- ${example}`),
        `Feedback from ${decision?.actor ?? "the person"}: ${decision?.comment ?? "none"}`,
      ].join("\n");
    })
    .join("\n\n") || "None: this is the first plan.";

export const triageDecision = (parsed: Record<string, unknown>) => ({
  decision: parsed.decision === "decline" ? ("decline" as const) : ("proceed" as const),
  reason: String(parsed.reason ?? "No reason given."),
});

const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

export type PlanningOutcome =
  | { status: "submitted"; plan: AgentPlan; version: number; verification: PlanVerification }
  | { status: "declined"; reason: string };

/**
 * The plan step. Reads the ticket and the repository at a pinned commit (no
 * setup or Docker yet) and submits the agent's own plan for a person to
 * approve; the run later clones the same commit and follows that plan. The
 * first version is triaged first, so a ticket the agent cannot do stops
 * before anyone is asked; a revision gets the earlier plans and feedback.
 */
export const planExecution = async (executionId: string): Promise<PlanningOutcome> => {
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: executionId },
    include: {
      repository: true,
      workItem: true,
      project: { include: { agents: true } },
      plans: { include: { tasks: true }, orderBy: { version: "asc" } },
      approvals: { where: { type: "PLAN" } },
    },
  });
  const agent = execution.project.agents[0];
  if (!agent) throw new NonRetryableError("Project has no implementation agent");
  const { repository, workItem } = execution;

  // Pinned on the first plan, so every revision and the run see the same code.
  const baseSha =
    execution.baseSha ??
    (await getBaseSha(repository.githubInstallationId, repository.owner, repository.name, repository.defaultBranch));
  if (!execution.baseSha) await prisma.execution.update({ where: { id: executionId }, data: { baseSha } });

  await removeWorkspace(executionId);
  await cloneGithubWorkspace(
    executionId,
    repository.owner,
    repository.name,
    baseSha,
    await getInstallationToken(repository.githubInstallationId),
  );
  try {
    const root = workspacePath(executionId);
    const { toolchain } = resolveToolchain(fsRepoFiles(root), repository.verificationConfig);
    const ticket = `${workItem.title}\n${workItem.description ?? ""}`;
    const repoContext = await collectRepoContext(root, ticket, toolchain);
    const checks = selectChecks(toolchain, repository.verificationConfig).run;
    const environment = describeEnvironment(toolchain, checks, config.executionAgentMode === "tool_loop");
    const verification = planVerification(toolchain, repository.verificationConfig, config.executionDiscoveryMaxAttempts);
    const calls = resolveAgentCalls(agent);
    const ctx: CallContext = {
      executionId,
      ...calls,
      // A model or effort configured for the plan covers both ways of writing it.
      callModels: { ...calls.callModels, planner: calls.callModels.planner ?? calls.callModels.plan },
      reasoningEffort: { ...calls.reasoningEffort, planner: calls.reasoningEffort.planner ?? calls.reasoningEffort.plan },
      maxTokens: positive((execution.budget as { maxTokens?: number } | null)?.maxTokens, 200_000),
    };

    if (!execution.plans.length) {
      const prompt = renderExecutionPrompt("triage", { ticket, environment, repoContext: repoContext.summary });
      const { decision, reason } = triageDecision(parseJsonRecord(await askAgent(ctx, prompt)));
      await graphEvent(executionId, "GRAPH_TICKET_TRIAGED", { decision, reason, promptVersion: prompt.version });
      if (decision === "decline") return { status: "declined", reason };
    }

    const revisions = describeRevisions(execution.plans, execution.approvals);
    // With tools the planner reads the code itself; without, it gets a sample of it (each file cut short).
    const withTools = config.executionAgentMode === "tool_loop";
    const prompt = withTools
      ? renderExecutionPrompt("planner", { ticket, environment, repoOverview: repoContext.overview, revisions })
      : renderExecutionPrompt("plan", { ticket, environment, repoContext: repoContext.summary, revisions });
    const policy = repository.executionPolicy as RepositoryPolicy | null;
    const noSandbox = async (): Promise<never> => {
      throw new Error("The plan step runs nothing");
    };
    const tools: ToolContext = {
      root,
      protectedPaths: [],
      checkScripts: [],
      runCheck: noSandbox,
      runCommand: noSandbox,
      isTestFile: (file) => isTestFile(toolchain, file),
      isBaseFile: () => true,
      reproduction: { shown: false, newTest: false },
      limits: { maxOutputChars: policy?.maxToolOutputChars, maxReadLines: policy?.maxReadLines },
    };
    const reply = withTools
      ? ((await runPlanner(tools, prompt, {
          generate: (request) => askAgentWithTools(ctx, request, prompt.version),
          maxTokens: Math.min(PLAN_MAX_TOKENS, Math.max(0, ctx.maxTokens - (await executionTokensUsed(ctx)))),
          deadline: Date.now() + config.executionMaxDurationSeconds * 1000,
          onStep: (step) =>
            graphEvent(executionId, "PLAN_STEP", {
              step: step.step,
              promptVersion: prompt.version,
              usage: step.usage,
              toolCalls: step.toolCalls.map(({ call, outcome }) => ({
                name: call.name,
                status: outcome.status,
                input: JSON.stringify(call.arguments).slice(0, 300),
              })),
            }),
        })) ?? {})
      : parseJsonRecord(await askAgent(ctx, prompt));
    const plan = planFromReply(reply, workItem.title);
    const submitted = await submitPlan(executionId, {
      summary: plan.summary,
      acceptanceCriteria: plan.expectedBehaviour.length ? plan.expectedBehaviour : [workItem.description || workItem.title],
      tasks: [
        {
          key: "implement",
          title: workItem.title,
          description: ticket,
          expectedOutput: plan,
        },
      ],
    });
    await graphEvent(executionId, "PLAN_WRITTEN", {
      version: submitted.version,
      promptVersion: prompt.version,
      verification,
      checks: checks.map((check) => check.name),
    });
    return { status: "submitted", plan, version: submitted.version, verification };
  } finally {
    // The run clones the pinned commit again; nothing waits on disk for a person.
    await removeWorkspace(executionId);
  }
};

/** The approved plan as the run's agent, analysis and reviewer read it, with the approver's note. */
export const describeApprovedPlan = (plan: Plan & { tasks: PlanTask[] }, approval: Approval | undefined) => {
  // The questions were for the person; approving the plan settled them.
  const { summary, expectedBehaviour, filesToEdit, risk, testStrategy } = storedPlan(plan);
  return JSON.stringify(
    {
      summary,
      expectedBehaviour,
      filesToEdit,
      risk,
      testStrategy,
      ...(approval?.comment ? { approverNote: approval.comment } : {}),
    },
    null,
    2,
  );
};
