import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Prisma, Repository } from "@prisma/client";
import fs from "node:fs/promises";
import path from "node:path";
import { ExecutionAgentMode, config } from "../../config";
import prisma from "../../db";
import { getBaseSha, getInstallationToken } from "../../integrations/githubApp";
import { writeActionsToRoot } from "../../utils/codeWriter";
import {
  EXECUTION_PROMPTS,
  ExecutionPromptName,
  RenderedPrompt,
  executionPromptFragment,
  renderExecutionPrompt,
} from "../../prompts";
import { NonRetryableError } from "../../utils/safeError";
import { parseAgentOutput } from "../../utils/llmUtils";
import { hashSnapshot } from "../executionService";
import { DurableCheckpointSaver, prismaCheckpointStore } from "./checkpointer";
import {
  askAgent,
  askAgentWithTools,
  executionTokensUsed,
  graphEvent,
  parseJsonRecord,
  resolveAgentCalls,
} from "./agentCalls";
import type { CallModel, ReasoningEffortConfig } from "./agentCalls";
import { ReviewVerdict, SANDBOX_TOOLS, agentTestCheck, describeReproduction } from "../sandbox/tools";
import { REVIEW_MAX_TOKENS, reviewOutcome, runReviewer } from "./reviewer";
import {
  executionToolContext,
  prismaToolCallRecorder,
  runRecordedTool,
} from "../sandbox/toolRunner";
import {
  changedFiles,
  changes,
  cloneGithubWorkspace,
  gitDiff,
  SetupFailedError,
  prepareVerification,
  setupWorkspace,
  buildEnvironmentImage,
  removeWorkspace,
  resetWorkspace,
  restoreClone,
  trackedFiles,
  startSandbox,
  stopSandbox,
  verifyWorkspace,
  workspacePath,
} from "../workspaceService";
import {
  Toolchain,
  ToolchainResolution,
  describeEnvironment,
  describeToolchain,
  isTestFile,
  fsRepoFiles,
  resolveToolchain,
  selectChecks,
} from "../toolchain";
import {
  FixedEnvironment,
  StoredProposal,
  applyProposal,
  discoverEnvironment,
  discoveryFiles,
  hashProposal,
} from "../toolchain/discovery";
import { AgentStep, AgentStopReason, attemptAllowance, describeAttempt, runAgentLoop } from "./agentLoop";
import { reviewDiffSafety } from "./diffReview";
import { fileActionsError } from "./outputFormat";
import { RepoContext, collectRepoContext } from "./repoContext";
import { describeApprovedPlan } from "./planning";
import { RepositoryPolicy, checkExistingTests, checkRepositoryPolicy } from "./repoPolicy";

const MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_SHARE = 0.5;
const FILE_BLOCK_FORMAT = executionPromptFragment("fileFormat");

type VerificationResult = Awaited<ReturnType<typeof verifyWorkspace>>;
type GraphRoute =
  | "retry"
  | "blocked"
  | "review"
  | "implemented"
  | "verify"
  | "artifact"
  | "skipped"
  | "proceed"
  | undefined;

const ExecutionGraphState = Annotation.Root({
  executionId: Annotation<string>(),
  baseSha: Annotation<string | undefined>(),
  planTaskId: Annotation<string | undefined>(),
  agentProvider: Annotation<string | undefined>(),
  agentModel: Annotation<string | undefined>(),
  agentApiKey: Annotation<string | undefined>(),
  /** A model per kind of call (agent config.models, keyed by prompt name); the agent's own where unset. */
  callModels: Annotation<Partial<Record<ExecutionPromptName, CallModel>>>({ reducer: (_old, value) => value, default: () => ({}) }),
  /** Reasoning effort per kind of call (agent config.reasoningEffort, keyed by prompt name). */
  reasoningEffort: Annotation<ReasoningEffortConfig>({ reducer: (_old, value) => value, default: () => ({}) }),
  ticket: Annotation<string | undefined>(),
  repoContext: Annotation<RepoContext | undefined>(),
  // How the repository is installed and checked, resolved after cloning.
  toolchain: Annotation<Toolchain | undefined>(),
  // What setup installed inside the workspace, restored before verification.
  setupOutputs: Annotation<string[]>({ reducer: (_old, value) => value, default: () => [] }),
  // Checks that failed on the unmodified code (the baseline), with the end of their output.
  failingBefore: Annotation<Record<string, string>>({ reducer: (_old, value) => value, default: () => ({}) }),
  // Set when the run uses an environment the agent proposed and nobody approved yet.
  environmentProposal: Annotation<ProposedEnvironment | undefined>(),
  // The environment as the prompts describe it (image, checks and their commands).
  environment: Annotation<string | undefined>(),
  internalPlan: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "",
  }),
  attemptNumber: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  attemptId: Annotation<string | undefined>(),
  lastFailure: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "",
  }),
  verification: Annotation<VerificationResult | undefined>(),
  route: Annotation<GraphRoute>(),
  agentMode: Annotation<ExecutionAgentMode>({
    reducer: (_current, update) => update,
    default: () => "single_shot",
  }),
  // Execution budget, set in load_context; enforced by the agent loop.
  maxSteps: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => config.agentMaxSteps,
  }),
  maxTokens: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  deadline: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  // Share of the remaining tokens and time each attempt but the last may use.
  attemptShare: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => DEFAULT_ATTEMPT_SHARE,
  }),
  // What the last tool-loop attempt did, for the failure analysis.
  attemptLog: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "",
  }),
  // Whether the next attempt continues from the last attempt's changes
  // instead of the base commit.
  keepChanges: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
  // How the tool loop showed the problem before changing code, for the reviewer.
  /** The reviewer's non-blocking remarks on the approved diff, shown with it. */
  reviewSuggestions: Annotation<string[]>({ reducer: (_old, value) => value, default: () => [] }),
  // Issues the reviewer still raised when attempts ran out, shown to the approver.
  reviewObjections: Annotation<string[]>({ reducer: (_old, value) => value, default: () => [] }),
  reproduction: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "Not tracked: the change was made without tools.",
  }),
  // The command whose failure showed the problem ("" if none); verification runs it again.
  reproductionCommand: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
});

type GraphState = typeof ExecutionGraphState.State;

/** The prompts a mode actually uses, recorded with every run. */
const promptVersionsFor = (mode: ExecutionAgentMode) => {
  const { implement, fileFormat, agent, review, reviewer, ...shared } = EXECUTION_PROMPTS;
  return mode === "tool_loop"
    ? { ...shared, agent, reviewer }
    : { ...shared, implement, fileFormat, review };
};

interface ExecutionBudget {
  maxSteps?: number;
  maxTokens?: number;
  maxDurationSeconds?: number;
  /** Share (0 to 1] of what is left that each attempt but the last may use. */
  attemptShare?: number;
}

const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;

const canRetry = (state: typeof ExecutionGraphState.State) =>
  state.attemptNumber < MAX_ATTEMPTS;

/** An unapproved environment the run uses, for the PR body. */
export interface ProposedEnvironment {
  repositoryId: string;
  hash: string;
  checks: Record<string, string[]>;
}

type SetupResult = Awaited<ReturnType<typeof setupWorkspace>>;

const describeFixed = (fixed: FixedEnvironment) =>
  [
    ...(fixed.image ? [`Image: ${fixed.image}`] : []),
    ...(fixed.setup ? [`Setup: ${fixed.setup.join(" ")}`] : []),
    ...Object.entries(fixed.env ?? {}).map(([name, value]) => `Env: ${name}=${value}`),
    ...(fixed.services ?? []).map(
      (service) =>
        `Service: host "${service.name}", image ${service.image}${Object.keys(service.env ?? {}).length ? `, env ${Object.entries(service.env!).map(([name, value]) => `${name}=${value}`).join(" ")}` : ""}`,
    ),
  ].join("\n") || "Nothing.";

/**
 * Sets the workspace up in the repository's environment. With approved
 * checks that is the resolved toolchain as it is. Without, the agent
 * proposes an environment from the project's files (or the proposal an
 * earlier run proved is reused), and setup plus the checks on the unmodified
 * code prove it; a proposal that fails goes back to the agent. A proved
 * proposal is stored on the repository until a person approves it. If none
 * works, the run continues in the resolved toolchain (the default image).
 */
const prepareEnvironment = async (
  executionId: string,
  repository: Repository,
  resolution: ToolchainResolution,
  ask: (prompt: RenderedPrompt) => Promise<string>,
): Promise<{ toolchain: Toolchain; setup: SetupResult; environmentProposal?: ProposedEnvironment }> => {
  const checksFor = (toolchain: Toolchain) => selectChecks(toolchain, repository.verificationConfig).run;
  const timeout = (repository.executionPolicy as RepositoryPolicy | null)?.setupTimeoutSeconds;
  const setupOptions = { cacheFor: repository.id, ...(timeout ? { setupTimeoutMs: timeout * 1000 } : {}) };
  const setUp = async (toolchain: Toolchain) => {
    const setup = await setupWorkspace(executionId, toolchain, checksFor(toolchain), setupOptions);
    return { toolchain: { ...toolchain, image: setup.image }, setup };
  };
  // The project's Dockerfile is the image; discovery and setup run in what it builds.
  if (resolution.toolchain.build) {
    const image = await buildEnvironmentImage(
      executionId,
      resolution.toolchain.image,
      resolution.toolchain.build,
      setupOptions.setupTimeoutMs,
    );
    await graphEvent(executionId, "GRAPH_ENVIRONMENT_BUILT", { dockerfile: resolution.toolchain.build.dockerfile, image });
    resolution = { ...resolution, toolchain: { ...resolution.toolchain, image } };
  }
  if (Object.keys(resolution.toolchain.checks).length || !config.executionDiscoveryMaxAttempts)
    return setUp(resolution.toolchain);

  // The image is never the model's choice: the project's, else the default
  // image (which has the common runtimes), and setup installs what it lacks.
  // A model naming images invents tags that do not exist.
  const fixed: FixedEnvironment = {
    image: resolution.toolchain.image,
    ...(resolution.toolchain.setup !== null ? { setup: resolution.toolchain.setup } : {}),
    ...(Object.keys(resolution.toolchain.env).length ? { env: resolution.toolchain.env } : {}),
    ...(resolution.toolchain.services ? { services: resolution.toolchain.services } : {}),
  };
  const stored = repository.environmentProposal as unknown as StoredProposal | null;
  const files = discoveryFiles(fsRepoFiles(workspacePath(executionId)), await trackedFiles(executionId));
  let proofs = 0;
  const result = await discoverEnvironment(
    { fixed, stored: stored?.toolchain, storedRationale: stored?.rationale, maxAttempts: config.executionDiscoveryMaxAttempts },
    {
      ask: (lastAttempt) =>
        ask(renderExecutionPrompt("discover", { fixed: describeFixed(fixed), files, lastAttempt })),
      prove: async (proposal) => {
        if (proofs++) await restoreClone(executionId);
        const toolchain = applyProposal(resolution.toolchain, proposal);
        try {
          return await setupWorkspace(executionId, toolchain, checksFor(toolchain), setupOptions);
        } catch (error) {
          if (!(error instanceof SetupFailedError)) throw error;
          return { setupError: error.message, image: toolchain.image, baseline: [], setupOutputs: [], cache: "none" as const };
        }
      },
    },
  );
  await graphEvent(executionId, "GRAPH_ENVIRONMENT_DISCOVERED", {
    proven: result.proven,
    fromStored: result.fromStored,
    rationale: result.rationale,
    attempts: result.attempts,
  });
  if (!result.proven || !result.proposal || !result.proof) {
    if (proofs) await restoreClone(executionId);
    return setUp(resolution.toolchain);
  }

  const hash = hashProposal(result.proposal);
  if (stored?.hash !== hash) {
    const proposal: StoredProposal = {
      toolchain: result.proposal,
      rationale: result.rationale,
      executionId,
      proposedAt: new Date().toISOString(),
      hash,
    };
    await prisma.repository.update({
      where: { id: repository.id },
      data: { environmentProposal: proposal as unknown as Prisma.InputJsonObject },
    });
  }
  const toolchain = applyProposal(resolution.toolchain, result.proposal);
  return {
    toolchain: { ...toolchain, image: result.proof.image },
    setup: result.proof,
    environmentProposal: { repositoryId: repository.id, hash, checks: toolchain.checks },
  };
};

const loadExecutionContext = async (
  state: typeof ExecutionGraphState.State,
) => {
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: state.executionId },
    include: {
      repository: true,
      workItem: true,
      project: { include: { agents: true } },
      plans: {
        where: { status: "APPROVED" },
        include: { tasks: true },
        orderBy: { version: "desc" },
        take: 1,
      },
      approvals: {
        where: { type: "PLAN", status: "APPROVED" },
        orderBy: { decidedAt: "desc" },
        take: 1,
      },
    },
  });
  // The worker claims the execution (status RUNNING + lease) before invoking the graph.
  if (execution.status !== "RUNNING")
    throw new NonRetryableError(
      `Execution graph started in unexpected status ${execution.status}`,
    );

  const agent = execution.project.agents[0];
  if (!agent) throw new Error("Project has no implementation agent");

  const approvedPlan = execution.plans[0];
  const planTask = approvedPlan?.tasks[0];
  if (!planTask) throw new Error("Approved plan has no task");
  const internalPlan = describeApprovedPlan(approvedPlan, execution.approvals[0]);

  // The commit the plan was made on; a plan submitted through the API has none yet.
  const baseSha =
    execution.baseSha ??
    (await getBaseSha(
      execution.repository.githubInstallationId,
      execution.repository.owner,
      execution.repository.name,
      execution.repository.defaultBranch,
    ));
  const githubToken = await getInstallationToken(
    execution.repository.githubInstallationId,
  );

  await cloneGithubWorkspace(
    execution.id,
    execution.repository.owner,
    execution.repository.name,
    baseSha,
    githubToken,
  );
  const agentMode = config.executionAgentMode;
  const budget = (execution.budget ?? {}) as ExecutionBudget;
  // The repository's limits win over the defaults each execution is created with.
  const policy = execution.repository.executionPolicy as RepositoryPolicy | null;
  const maxSteps = positive(budget.maxSteps ?? policy?.maxAgentSteps, config.agentMaxSteps);
  const maxTokens = positive(budget.maxTokens, 200_000);
  const deadline =
    Date.now() + positive(policy?.maxRunSeconds ?? budget.maxDurationSeconds, 1800) * 1000;
  const attemptShare = Math.min(1, positive(budget.attemptShare, DEFAULT_ATTEMPT_SHARE));
  const calls = resolveAgentCalls(agent);
  const { callModels, reasoningEffort } = calls;

  // The repository's configuration or the project's own definition decides
  // the image, setup step and checks; nothing is chosen per language.
  const resolution = resolveToolchain(
    fsRepoFiles(workspacePath(execution.id)),
    execution.repository.verificationConfig,
  );
  await graphEvent(execution.id, "GRAPH_TOOLCHAIN_RESOLVED", {
    source: resolution.source,
    reason: resolution.reason,
    notes: resolution.notes,
    image: resolution.toolchain.image,
    ...(resolution.toolchain.build ? { build: resolution.toolchain.build } : {}),
    setup: resolution.toolchain.setup !== null,
    checks: Object.keys(resolution.toolchain.checks),
  });
  // Discovery's model calls count against this execution's budget.
  const ask = (prompt: RenderedPrompt) =>
    askAgent({ ...state, ...calls, maxTokens }, prompt);
  // Later commands run in the snapshot taken after setup and the baseline checks.
  const { toolchain, setup, environmentProposal } = await prepareEnvironment(
    execution.id,
    execution.repository,
    resolution,
    ask,
  );
  // Failures here existed before the agent changed anything.
  const failingBefore = Object.fromEntries(
    setup.baseline.filter((result) => !result.passed).map((result) => [result.check, result.output.slice(-2000)]),
  );
  await graphEvent(execution.id, "GRAPH_BASELINE_CHECKED", {
    results: setup.baseline.map(({ check, passed }) => ({ check, passed })),
    failing: setup.baseline.filter((result) => !result.passed).map((result) => result.check),
    environmentSnapshot: setup.cache,
  });

  await prisma.execution.update({
    where: { id: execution.id },
    data: { baseSha },
  });
  await graphEvent(execution.id, "GRAPH_CONTEXT_LOADED", {
    repositoryId: execution.repositoryId,
    workItemId: execution.workItemId,
    planTaskId: planTask.id,
    agentMode,
    budget: { maxSteps, maxTokens, maxDurationSeconds: (deadline - Date.now()) / 1000, attemptShare },
    promptVersions: promptVersionsFor(agentMode),
    ...(Object.keys(callModels).length
      ? { callModels: Object.fromEntries(Object.entries(callModels).map(([name, entry]) => [name, `${entry.provider}/${entry.model}`])) }
      : {}),
    ...(Object.keys(reasoningEffort).length ? { reasoningEffort } : {}),
  });
  // The plan the run follows (the approved one), under the event the reviewer eval reads.
  await graphEvent(execution.id, "GRAPH_INTERNAL_PLAN_CREATED", {
    internalPlan,
    planVersion: approvedPlan.version,
  });

  return {
    baseSha,
    planTaskId: planTask.id,
    internalPlan,
    ...calls,
    ticket: `${execution.workItem.title}\n${execution.workItem.description ?? ""}`,
    agentMode,
    maxSteps,
    maxTokens,
    deadline,
    attemptShare,
    toolchain,
    setupOutputs: setup.setupOutputs,
    failingBefore,
    environmentProposal,
    environment: describeEnvironment(
      toolchain,
      selectChecks(toolchain, execution.repository.verificationConfig).run,
      agentMode === "tool_loop",
      Object.keys(failingBefore),
    ),
  };
};

const requireToolchain = (state: GraphState) => {
  if (!state.toolchain) throw new Error("Execution graph is missing the toolchain");
  return state.toolchain;
};

const inspectRepository = async (state: typeof ExecutionGraphState.State) => {
  if (!state.ticket) throw new Error("Execution graph is missing ticket");
  const repoContext = await collectRepoContext(
    workspacePath(state.executionId),
    state.ticket,
    requireToolchain(state),
  );
  await graphEvent(state.executionId, "GRAPH_REPOSITORY_INSPECTED", {
    fileTreeCount: repoContext.fileTree.length,
    selectedFiles: repoContext.selectedFiles,
    toolchain: describeToolchain(requireToolchain(state)),
  });
  return { repoContext };
};

const startAttempt = async (state: GraphState) => {
  if (!state.planTaskId || !state.ticket) {
    throw new Error("Execution graph is missing task context");
  }
  const attemptNumber = state.attemptNumber + 1;
  // A run that resumes after a crash re-runs the interrupted attempt; the
  // record it left behind is closed, and numbering continues after it.
  await prisma.taskAttempt.updateMany({
    where: { planTaskId: state.planTaskId, status: "RUNNING" },
    data: { status: "CANCELED", error: "Interrupted; the attempt was run again.", completedAt: new Date() },
  });
  const previous = await prisma.taskAttempt.aggregate({
    where: { planTaskId: state.planTaskId },
    _max: { number: true },
  });
  const attempt = await prisma.taskAttempt.create({
    data: {
      planTaskId: state.planTaskId,
      number: (previous._max.number ?? 0) + 1,
      workspaceId: state.executionId,
    },
  });
  await graphEvent(state.executionId, "GRAPH_ATTEMPT_STARTED", {
    attemptId: attempt.id,
    attemptNumber,
    agentMode: state.agentMode,
    promptVersions: promptVersionsFor(state.agentMode),
  });
  return { attempt, attemptNumber, ticket: state.ticket };
};

const implementChange = async (state: GraphState) => {
  const { attempt, attemptNumber, ticket } = await startAttempt(state);

  const raw = await askAgent(
    state,
    renderExecutionPrompt("implement", {
      ticket,
      environment: state.environment ?? "Unknown.",
      internalPlan: state.internalPlan || "No internal plan was produced.",
      repoContext:
        state.repoContext?.summary ?? "No repository context was collected.",
      lastFailure: state.lastFailure || "None",
      fileBlockFormat: FILE_BLOCK_FORMAT,
    }),
  );
  const parsed = parseAgentOutput(raw);

  // A malformed reply is a failed attempt the model can correct, not a crash
  // of the whole run. Parsing is pure, so nothing has been written yet.
  const formatError = fileActionsError(raw, parsed.actions);
  if (formatError) {
    await prisma.taskAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "FAILED",
        error: `${formatError}\n--- model reply (tail) ---\n${raw.slice(-4000)}`,
        completedAt: new Date(),
      },
    });
    await graphEvent(state.executionId, "GRAPH_OUTPUT_REJECTED", {
      attemptId: attempt.id,
      attemptNumber,
      reason: formatError,
    });
    return {
      attemptNumber,
      attemptId: attempt.id,
      lastFailure: `Your previous reply was rejected: ${formatError}. ${FILE_BLOCK_FORMAT}`,
      route: (attemptNumber < MAX_ATTEMPTS ? "retry" : "blocked") as GraphRoute,
    };
  }

  // Each attempt starts from the base commit, so a retry never builds on a
  // failed attempt's edits (and files it added don't linger), nor an attempt
  // re-run after a crash on its own partial edits.
  await resetWorkspace(state.executionId);
  writeActionsToRoot(
    parsed.actions,
    path.resolve(config.workspaceRoot, state.executionId),
  );

  return {
    attemptNumber,
    attemptId: attempt.id,
    route: "implemented" as GraphRoute,
  };
};

const MAX_EVENT_TEXT_CHARS = 2000;
const MAX_EVENT_PREVIEW_CHARS = 500;

/** Why an attempt ended without a usable change, as feedback for the next one. */
const LOOP_FAILURES: Record<Exclude<AgentStopReason, "done">, string> = {
  blocked: "The agent declined the ticket",
  max_steps: "The agent ran out of steps",
  max_tokens: "The execution's token budget ran out",
  timeout: "The execution's time budget ran out",
  no_finish: "The agent stopped without finishing",
};
const ATTEMPT_SHARE_FAILURES = {
  max_tokens: "The attempt used its share of the token budget",
  timeout: "The attempt used its share of the time budget",
};
const KEPT_CHANGES =
  "The changes the previous attempt made are kept in the repository: check them and continue from them.";
const RESET_CHANGES =
  "The repository is back at the unmodified code: none of the previous attempt's changes are kept.";

/**
 * Tool-loop alternative to implement_change: the agent edits the workspace
 * through sandbox tools until it calls finish or a budget runs out. The
 * policy, verification and review nodes still run after it.
 */
const agentLoop = async (state: GraphState) => {
  const { attempt, attemptNumber, ticket } = await startAttempt(state);
  // Each attempt starts from the base commit, as in single-shot mode, unless
  // the last one was only stopped by its share of the budget.
  if (!state.keepChanges) await resetWorkspace(state.executionId);

  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: state.executionId },
    include: { repository: true },
  });
  const toolchain = requireToolchain(state);
  const ctx = await executionToolContext(state.executionId, execution.repository, toolchain, state.failingBefore);
  const recorder = prismaToolCallRecorder(attempt.id);
  const prompt = renderExecutionPrompt("agent", {
    ticket,
    internalPlan: state.internalPlan || "No internal plan was produced.",
    // File list only: the agent reads what it needs, instead of every step
    // re-sending the selected files' contents.
    repoOverview:
      state.repoContext?.overview ?? "No repository overview was collected.",
    lastFailure: state.lastFailure
      ? `${state.lastFailure}\n\n${state.keepChanges ? KEPT_CHANGES : RESET_CHANGES}`
      : "None",
    environment: state.environment ?? "Unknown.",
  });

  // The loop may use what is left of the execution's budget after planning
  // and any earlier attempts. Every attempt but the last also gets a share
  // of it as a soft limit, so a retry still has room: past it, an attempt
  // with no changes stops, and one with changes is told to wrap up.
  const usedBefore = await executionTokensUsed(state);
  const tokensLeft = Math.max(0, state.maxTokens - usedBefore);
  const timeLeft = Math.max(0, state.deadline - Date.now());
  const attemptBudget = {
    maxSteps: state.maxSteps,
    maxTokens: tokensLeft,
    deadline: state.deadline,
    soft:
      attemptNumber < MAX_ATTEMPTS
        ? {
            maxTokens: attemptAllowance(tokensLeft, attemptNumber, MAX_ATTEMPTS, state.attemptShare),
            deadline: Date.now() + attemptAllowance(timeLeft, attemptNumber, MAX_ATTEMPTS, state.attemptShare),
          }
        : undefined,
  };
  const steps: AgentStep[] = [];
  await startSandbox(state.executionId, toolchain);
  let outcome: Awaited<ReturnType<typeof runAgentLoop>>;
  try {
    outcome = await runAgentLoop(
      {
        system: prompt.system,
        task: prompt.user,
        tools: SANDBOX_TOOLS,
        budget: attemptBudget,
      },
      {
        generate: (request) => askAgentWithTools(state, request, prompt.version),
        runTool: (call) => runRecordedTool(ctx, call, recorder),
        hasChanges: async () => (await changedFiles(state.executionId)).length > 0,
        // One event per model call; full tool input and output are in ToolCall.
        onStep: (step) => {
          steps.push(step);
          return graphEvent(state.executionId, "GRAPH_AGENT_STEP", {
            attemptId: attempt.id,
            attemptNumber,
            step: step.step,
            promptVersion: prompt.version,
            text: step.text.slice(0, MAX_EVENT_TEXT_CHARS),
            usage: step.usage,
            toolCalls: step.toolCalls.map(({ call, outcome: result }) => ({
              name: call.name,
              status: result.status,
              input: JSON.stringify(call.arguments).slice(0, MAX_EVENT_PREVIEW_CHARS),
              output: result.output.slice(0, MAX_EVENT_PREVIEW_CHARS),
            })),
          });
        },
      },
    );
  } finally {
    await stopSandbox(state.executionId);
  }

  const tokensUsed = usedBefore + outcome.usage.inputTokens + outcome.usage.outputTokens;
  await graphEvent(state.executionId, "GRAPH_AGENT_FINISHED", {
    attemptId: attempt.id,
    attemptNumber,
    stopReason: outcome.stopReason,
    summary: outcome.summary.slice(0, MAX_EVENT_TEXT_CHARS),
    steps: outcome.steps,
    usage: outcome.usage,
    attemptBudget: {
      maxTokens: attemptBudget.maxTokens,
      maxDurationSeconds: Math.round(timeLeft / 1000),
      shareTokens: attemptBudget.soft?.maxTokens,
    },
    tokensUsed,
  });

  const attemptLog = describeAttempt(steps);
  // Running out of this attempt's share, not of the execution's budget,
  // leaves room for another attempt.
  const executionSpent =
    (outcome.stopReason === "max_tokens" && tokensUsed >= state.maxTokens) ||
    (outcome.stopReason === "timeout" && Date.now() >= state.deadline);
  const changed = await changedFiles(state.executionId);
  let failure: string;
  let keepChanges = false;
  if (outcome.stopReason === "done") {
    if (changed.length > 0) {
      const codeChanged = changed.some((file) => !isTestFile(toolchain, file));
      const reproduction = describeReproduction(ctx.reproduction, codeChanged);
      const reproductionCommand = ctx.reproduction.command ?? "";
      return { attemptNumber, attemptId: attempt.id, attemptLog, keepChanges, reproduction, reproductionCommand, route: "implemented" as GraphRoute };
    }
    failure = `The agent called finish without changing any files: ${outcome.summary}`;
  } else if ((outcome.stopReason === "max_tokens" || outcome.stopReason === "timeout") && !executionSpent) {
    // Stopped part-way, not wrong: the next attempt continues from these
    // changes with a fresh conversation instead of redoing them.
    keepChanges = changed.length > 0;
    failure = `${ATTEMPT_SHARE_FAILURES[outcome.stopReason]}: ${outcome.summary}`;
  } else {
    failure = `${LOOP_FAILURES[outcome.stopReason]}: ${outcome.summary}`;
  }
  await prisma.taskAttempt.update({
    where: { id: attempt.id },
    data: { status: "FAILED", error: failure, completedAt: new Date() },
  });
  // A refusal is the agent's decision, and an exhausted execution budget
  // cannot recover; only a per-attempt failure is worth another attempt.
  const final = outcome.stopReason === "blocked" || executionSpent || attemptNumber >= MAX_ATTEMPTS;
  return {
    attemptNumber,
    attemptId: attempt.id,
    lastFailure: failure,
    attemptLog,
    keepChanges,
    route: (final ? "blocked" : "retry") as GraphRoute,
  };
};

const enforceRepositoryPolicy = async (
  state: typeof ExecutionGraphState.State,
) => {
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: state.executionId },
    include: { repository: true },
  });
  const toolchain = requireToolchain(state);
  const diff = await changes(state.executionId);
  const files = diff.map((change) => change.file);
  const violation =
    checkRepositoryPolicy(
      files,
      execution.repository.executionPolicy as RepositoryPolicy | null,
      toolchain.protectedPaths,
    ) ?? checkExistingTests(diff, (file) => isTestFile(toolchain, file));

  if (violation) {
    if (!state.attemptId) throw new Error("Execution graph is missing attempt");
    await prisma.taskAttempt.update({
      where: { id: state.attemptId },
      data: { status: "FAILED", error: violation, completedAt: new Date() },
    });
    await graphEvent(state.executionId, "GRAPH_POLICY_FAILED", {
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
      files,
      reason: violation,
    });
    return {
      lastFailure: violation,
      route: (canRetry(state) ? "retry" : "blocked") as GraphRoute,
    };
  }

  await graphEvent(state.executionId, "GRAPH_POLICY_PASSED", { files });
  return { route: "verify" as GraphRoute };
};

const verifyChange = async (state: typeof ExecutionGraphState.State) => {
  if (!state.attemptId) throw new Error("Execution graph is missing attempt");

  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: state.executionId },
    include: { repository: true },
  });
  await prisma.execution.update({
    where: { id: state.executionId },
    data: { status: "VERIFYING" },
  });
  const toolchain = requireToolchain(state);
  // Checks judge only the diff: nothing hidden from it may influence them.
  await prepareVerification(state.executionId, toolchain.image, state.setupOutputs);
  const checks = selectChecks(toolchain, execution.repository.verificationConfig);
  // The agent's own test runs too, after the repository's checks have built the change.
  const agentTest = agentTestCheck({ command: state.reproductionCommand });
  const runsAlready = (command: string[]) => checks.run.some((check) => check.command.join(" ") === command.join(" ") || check.command.join(" ") === command[2]);
  const verification = await verifyWorkspace(
    state.executionId,
    toolchain,
    agentTest && !runsAlready(agentTest.command) ? { ...checks, run: [...checks.run, agentTest] } : checks,
    Object.keys(state.failingBefore),
  );

  if (!verification.passed) {
    const lastFailure = JSON.stringify(verification.results).slice(-10000);
    await prisma.taskAttempt.update({
      where: { id: state.attemptId },
      data: { status: "FAILED", error: lastFailure, completedAt: new Date() },
    });
    await graphEvent(state.executionId, "GRAPH_VERIFICATION_FAILED", {
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
    });
    return {
      lastFailure,
      verification,
      route: state.attemptNumber < MAX_ATTEMPTS ? "retry" : "blocked",
    };
  }

  // Passing with no checks run means unverified, and the reviewer must see that.
  await graphEvent(state.executionId, "GRAPH_VERIFICATION_PASSED", {
    attemptId: state.attemptId,
    attemptNumber: state.attemptNumber,
    checksRun: verification.checksRun,
    unavailable: verification.results.filter((result) => result.unavailable).map((result) => result.script),
    failingBefore: verification.results.filter((result) => result.failingBefore).map((result) => result.script),
    unverified: verification.checksRun === 0,
  });
  return { verification, route: "review" };
};

const analyzeFailure = async (state: typeof ExecutionGraphState.State) => {
  // In tool-loop mode the analysis also sees what the attempt did, not only
  // how it ended.
  const prompt = renderExecutionPrompt("analyze", {
    ticket: state.ticket ?? "",
    internalPlan: state.internalPlan,
    lastFailure: state.attemptLog
      ? `${state.lastFailure}\n\nWhat the attempt did:\n${state.attemptLog}`
      : state.lastFailure,
    workspace: state.keepChanges ? KEPT_CHANGES : RESET_CHANGES,
  });
  const raw = await askAgent(state, prompt);
  const parsed = parseJsonRecord(raw);
  const guidance = JSON.stringify(
    {
      summary: parsed.summary ?? "Previous attempt failed.",
      nextAttemptGuidance:
        parsed.nextAttemptGuidance ?? "Make a smaller targeted fix.",
      avoid: parsed.avoid ?? ["Do not modify unrelated files."],
    },
    null,
    2,
  );
  await graphEvent(state.executionId, "GRAPH_FAILURE_ANALYZED", {
    guidance,
    promptVersion: prompt.version,
  });
  return { lastFailure: guidance };
};

const reviewWithTools = async (
  state: GraphState,
  input: Record<string, string>,
): Promise<{ prompt: RenderedPrompt; review: ReviewVerdict }> => {
  if (!state.attemptId) throw new Error("Execution graph is missing attempt");
  const attemptId = state.attemptId;
  const execution = await prisma.execution.findUniqueOrThrow({
    where: { id: state.executionId },
    include: { repository: true },
  });
  const ctx = await executionToolContext(state.executionId, execution.repository, requireToolchain(state));
  const prompt = renderExecutionPrompt("reviewer", input);
  const review = await runReviewer(ctx, prompt, {
    generate: (request) => askAgentWithTools(state, request, prompt.version),
    recorder: prismaToolCallRecorder(attemptId),
    maxTokens: Math.min(REVIEW_MAX_TOKENS, Math.max(0, state.maxTokens - (await executionTokensUsed(state)))),
    deadline: state.deadline,
    onStep: (step) =>
      graphEvent(state.executionId, "GRAPH_REVIEW_STEP", {
        attemptId,
        step: step.step,
        promptVersion: prompt.version,
        text: step.text.slice(0, MAX_EVENT_TEXT_CHARS),
        usage: step.usage,
        toolCalls: step.toolCalls.map(({ call, outcome: result }) => ({
          name: call.name,
          status: result.status,
          input: JSON.stringify(call.arguments).slice(0, MAX_EVENT_PREVIEW_CHARS),
          output: result.output.slice(0, MAX_EVENT_PREVIEW_CHARS),
        })),
      }),
  });
  return { prompt, review };
};

/** What verification ran on this change, for the reviewer: a test is evidence only if one of these ran it. */
export const describeChecksRun = (verification: unknown) => {
  const { results } = (verification ?? {}) as { results?: Array<{ script: string; passed: boolean; unavailable?: true; failingBefore?: true }> };
  const ran = (results ?? []).filter((result) => !result.unavailable);
  if (!ran.length) return "No checks ran: nothing about this change was tested.";
  return ran
    .map((result) => `- ${result.script}: ${result.failingBefore ? "failed, as it already did on the unmodified code" : "passed"}`)
    .join("\n");
};

const reviewDiff = async (state: typeof ExecutionGraphState.State) => {
  if (!state.attemptId) throw new Error("Execution graph is missing attempt");

  const diff = await gitDiff(state.executionId);
  const files = await changedFiles(state.executionId);
  const deterministicReview = reviewDiffSafety(diff, files);
  if (!deterministicReview.passed) {
    const feedback = deterministicReview.issues.join("\n");
    await prisma.taskAttempt.update({
      where: { id: state.attemptId },
      data: { status: "FAILED", error: feedback, completedAt: new Date() },
    });
    await graphEvent(state.executionId, "GRAPH_DIFF_REVIEW_FAILED", {
      attemptId: state.attemptId,
      issues: deterministicReview.issues,
    });
    return {
      lastFailure: feedback,
      route: canRetry(state) ? "retry" : "blocked",
    };
  }

  const reviewInput = {
    ticket: state.ticket ?? "",
    internalPlan: state.internalPlan,
    changedFiles: files.join("\n"),
    diff: diff.slice(0, 80_000),
    reproduction: state.reproduction,
  };
  let prompt: RenderedPrompt;
  let review: ReviewVerdict;
  if (state.agentMode === "tool_loop") {
    ({ prompt, review } = await reviewWithTools(state, { ...reviewInput, verification: describeChecksRun(state.verification) }));
  } else {
    prompt = renderExecutionPrompt("review", reviewInput);
    const parsed = parseJsonRecord(await askAgent(state, prompt));
    review = {
      approved: parsed.approved === true,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.map(String)
        : ["Diff reviewer did not approve the change."],
      summary: String(parsed.summary ?? "Diff reviewer approved the change."),
    };
  }
  const outcome = reviewOutcome(review, canRetry(state));
  if (!review.approved) {
    const issues = review.issues.length ? review.issues : [review.summary];
    if (outcome.route === "retry")
      await prisma.taskAttempt.update({
        where: { id: state.attemptId },
        data: { status: "FAILED", error: outcome.lastFailure, completedAt: new Date() },
      });
    await graphEvent(state.executionId, "GRAPH_DIFF_REVIEW_FAILED", {
      attemptId: state.attemptId,
      issues,
      suggestions: review.suggestions ?? [],
      checks: review.checks,
      promptVersion: prompt.version,
      handedToApprover: outcome.route === "artifact",
    });
    return outcome;
  }

  await graphEvent(state.executionId, "GRAPH_DIFF_REVIEW_PASSED", {
    attemptId: state.attemptId,
    summary: review.summary,
    suggestions: review.suggestions ?? [],
    checks: review.checks,
    promptVersion: prompt.version,
  });
  return outcome;
};

const blockExecution = async (state: typeof ExecutionGraphState.State) => {
  await prisma.execution.update({
    where: { id: state.executionId },
    data: {
      status: "BLOCKED",
      lastError: state.lastFailure,
      completedAt: new Date(),
    },
  });
  await graphEvent(state.executionId, "GRAPH_BLOCKED", {
    attempts: state.attemptNumber,
  });
  return {};
};

const createDiffArtifact = async (state: typeof ExecutionGraphState.State) => {
  if (!state.attemptId || !state.verification) {
    throw new Error("Execution graph is missing successful attempt evidence");
  }

  const diff = await gitDiff(state.executionId);
  if (!diff.trim()) throw new Error("Agent produced no repository changes");

  await fs.mkdir(config.artifactRoot, { recursive: true });
  const artifactPath = path.resolve(
    config.artifactRoot,
    `${state.executionId}.diff`,
  );
  await fs.writeFile(artifactPath, diff, "utf8");
  const sha256 = hashSnapshot(diff);

  await prisma.$transaction([
    prisma.taskAttempt.update({
      where: { id: state.attemptId },
      data: { status: "COMPLETED", completedAt: new Date() },
    }),
    prisma.artifact.create({
      data: {
        executionId: state.executionId,
        attemptId: state.attemptId,
        type: "DIFF",
        name: "changes.diff",
        storagePath: artifactPath,
        sha256,
        metadata: {
          ...state.verification,
          ...(state.environmentProposal ? { environmentProposal: state.environmentProposal } : {}),
          ...(state.reviewSuggestions.length ? { reviewSuggestions: state.reviewSuggestions } : {}),
          ...(state.reviewObjections.length ? { reviewObjections: state.reviewObjections } : {}),
        } as unknown as Prisma.InputJsonObject,
      },
    }),
    prisma.approval.create({
      data: {
        executionId: state.executionId,
        type: "PUBLISH",
        snapshotHash: sha256,
      },
    }),
    prisma.execution.update({
      where: { id: state.executionId },
      data: { status: "AWAITING_PUBLISH_APPROVAL" },
    }),
  ]);
  await graphEvent(state.executionId, "GRAPH_DIFF_ARTIFACT_CREATED", {
    attemptId: state.attemptId,
    sha256,
  });
  return {};
};

const routeAfterVerification = (state: typeof ExecutionGraphState.State) => {
  if (!state.route) throw new Error("Execution graph route was not set");
  return state.route;
};

/** The node that makes the change: one model call, or the agent loop. */
const implementNode = (state: GraphState) =>
  state.agentMode === "tool_loop" ? "agent_loop" : "implement_change";

const routeAfterFailure = (state: GraphState) =>
  canRetry(state) ? implementNode(state) : "blocked";

const checkpointer = new DurableCheckpointSaver(prismaCheckpointStore);

const graph = new StateGraph(ExecutionGraphState)
  .addNode("load_context", loadExecutionContext)
  .addNode("inspect_repo", inspectRepository)
  .addNode("implement_change", implementChange)
  .addNode("agent_loop", agentLoop)
  .addNode("enforce_policy", enforceRepositoryPolicy)
  .addNode("verify_change", verifyChange)
  .addNode("analyze_failure", analyzeFailure)
  .addNode("review_diff", reviewDiff)
  .addNode("block_execution", blockExecution)
  .addNode("create_diff_artifact", createDiffArtifact)
  .addEdge(START, "load_context")
  .addEdge("load_context", "inspect_repo")
  .addConditionalEdges("inspect_repo", implementNode, {
    implement_change: "implement_change",
    agent_loop: "agent_loop",
  })
  .addConditionalEdges("implement_change", routeAfterVerification, {
    implemented: "enforce_policy",
    retry: "implement_change",
    blocked: "block_execution",
  })
  .addConditionalEdges("agent_loop", routeAfterVerification, {
    implemented: "enforce_policy",
    retry: "analyze_failure",
    blocked: "block_execution",
  })
  .addConditionalEdges("enforce_policy", routeAfterVerification, {
    verify: "verify_change",
    retry: "analyze_failure",
    blocked: "block_execution",
  })
  .addConditionalEdges("verify_change", routeAfterVerification, {
    retry: "analyze_failure",
    blocked: "block_execution",
    review: "review_diff",
  })
  .addConditionalEdges("review_diff", routeAfterVerification, {
    retry: "analyze_failure",
    blocked: "block_execution",
    artifact: "create_diff_artifact",
  })
  .addConditionalEdges("analyze_failure", routeAfterFailure, {
    implement_change: "implement_change",
    agent_loop: "agent_loop",
    blocked: "block_execution",
  })
  .addEdge("block_execution", END)
  .addEdge("create_diff_artifact", END)
  .compile({ checkpointer });

const workspaceExists = async (executionId: string) =>
  fs.access(path.join(workspacePath(executionId), ".git")).then(
    () => true,
    () => false,
  );

/**
 * Runs an execution's graph, or resumes it. Each finished step is saved, so
 * a run that failed (and is redelivered) or whose worker died continues from
 * the step that did not finish, with the workspace as that step left it,
 * instead of cloning, setting up, planning and repeating attempts again.
 * Without a saved step or the workspace (another machine), it starts over.
 */
export const runExecutionGraph = async (executionId: string) => {
  const thread = { configurable: { thread_id: executionId } };
  // Another worker may have advanced the stored copy since this one ran it.
  checkpointer.evict(executionId);
  const saved = await graph.getState(thread);
  const resume = saved.next.length > 0 && (await workspaceExists(executionId));
  if (resume) {
    await graphEvent(executionId, "GRAPH_RESUMED", { next: saved.next });
  } else {
    await checkpointer.deleteThread(executionId);
    // A clone left by a run that cannot be resumed is set up afresh.
    await removeWorkspace(executionId);
  }
  await graph.invoke(resume ? null : { executionId }, thread);
  // Finished (artifact or blocked): the approved diff is stored under
  // ARTIFACT_ROOT and publishing uses a fresh clone. On failure both are
  // kept for the retry; discardExecutionRun removes them once none is left.
  await discardExecutionRun(executionId);
};

/** Removes what a run keeps for resuming: its saved steps and its workspace. */
export const discardExecutionRun = async (executionId: string) => {
  await checkpointer.deleteThread(executionId);
  if (!config.keepWorkspaces) await removeWorkspace(executionId);
};
