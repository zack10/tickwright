import { Agent, Prisma } from "@prisma/client";
import prisma from "../../db";
import { decrypt } from "../../utils/crypto";
import { EXECUTION_PROMPTS, ExecutionPromptName, RenderedPrompt } from "../../prompts";
import { LLMService } from "../llm/LLMService";
import { ReasoningEffort, ToolRequest } from "../llm/types";
import { TokenLimitError, prismaUsageLedger } from "../llm/usageLedger";

/**
 * Model calls an execution makes, shared by the plan step and the run graph:
 * which model answers each kind of call, within the execution's token budget.
 */
export const llm = new LLMService();

export type ReasoningEffortConfig = Partial<Record<ExecutionPromptName, ReasoningEffort>>;
export type CallModel = { provider: string; model: string; apiKey?: string };

/** Who answers an execution's calls; the run graph's state is one. */
export interface CallContext {
  executionId: string;
  agentProvider?: string;
  agentModel?: string;
  agentApiKey?: string;
  /** A model per kind of call (agent config.models, keyed by prompt name); the agent's own where unset. */
  callModels: Partial<Record<ExecutionPromptName, CallModel>>;
  /** Reasoning effort per kind of call (agent config.reasoningEffort, keyed by prompt name). */
  reasoningEffort: ReasoningEffortConfig;
  maxTokens: number;
}

/** The agent's provider, model and key, and the models configured per kind of call. */
export const resolveAgentCalls = (agent: Agent) => {
  const resolved = llm.resolveModel(agent);
  const agentConfig = agent.config as
    | {
        apiKey?: string;
        reviewer?: CallModel;
        models?: Partial<Record<ExecutionPromptName, CallModel>>;
        reasoningEffort?: ReasoningEffortConfig;
      }
    | null;
  const reasoningEffort = agentConfig?.reasoningEffort ?? {};
  const agentApiKey = agentConfig?.apiKey ? decrypt(agentConfig.apiKey) : undefined;
  // config.reviewer is the older form of models.review and models.reviewer.
  const { reviewer } = agentConfig ?? {};
  const callModels = Object.fromEntries(
    Object.entries({ ...(reviewer ? { review: reviewer, reviewer } : {}), ...agentConfig?.models }).map(
      ([name, entry]) => {
        const model = llm.resolveModel(entry);
        // Without its own key, a model of the agent's provider uses the agent's key.
        const apiKey = entry.apiKey ? decrypt(entry.apiKey) : model.provider === resolved.provider ? agentApiKey : undefined;
        return [name, { ...model, apiKey }];
      },
    ),
  ) as Partial<Record<ExecutionPromptName, CallModel>>;
  return { agentProvider: resolved.provider, agentModel: resolved.model, agentApiKey, callModels, reasoningEffort };
};

const requireAgent = (ctx: CallContext) => {
  if (!ctx.agentProvider || !ctx.agentModel)
    throw new Error("Execution graph is missing the agent's provider or model");
  return { provider: ctx.agentProvider, model: ctx.agentModel };
};

/** The kind of call a prompt version belongs to (its EXECUTION_PROMPTS name). */
const callKind = (version: string) =>
  (Object.keys(EXECUTION_PROMPTS) as ExecutionPromptName[]).find((key) => EXECUTION_PROMPTS[key] === version);

/** The configured effort for the call a prompt version belongs to; unset leaves the model's default. */
const effortFor = (ctx: CallContext, version: string) => {
  const name = callKind(version);
  return name ? ctx.reasoningEffort[name] : undefined;
};

/** The model a call runs on: the one configured for its kind, else the agent's own. */
const modelFor = (ctx: CallContext, version: string): CallModel => {
  const name = callKind(version);
  return (name && ctx.callModels[name]) || { ...requireAgent(ctx), apiKey: ctx.agentApiKey };
};

/** Tokens every model call of this execution has used, from the usage ledger. */
export const executionTokensUsed = (ctx: CallContext) => prismaUsageLedger.tokensUsedByExecution(ctx.executionId);

/**
 * Sends a prompt to the execution's agent. Refused once the execution's
 * token budget is used up, which covers the plan, review and analysis calls
 * as well as the loop.
 */
export const askAgent = async (ctx: CallContext, prompt: RenderedPrompt) => {
  const { provider, model, apiKey } = modelFor(ctx, prompt.version);
  const used = await executionTokensUsed(ctx);
  if (used >= ctx.maxTokens)
    throw new TokenLimitError(
      `Execution token budget reached: ${used} of ${ctx.maxTokens} tokens used (budget.maxTokens)`,
    );
  return llm.generateContent(provider, model, { ...prompt, reasoningEffort: effortFor(ctx, prompt.version) }, apiKey, {
    purpose: prompt.version,
    executionId: ctx.executionId,
  });
};

export const askAgentWithTools = (ctx: CallContext, request: ToolRequest, purpose: string) => {
  const { provider, model, apiKey } = modelFor(ctx, purpose);
  return llm.generateWithTools(provider, model, { ...request, reasoningEffort: effortFor(ctx, purpose) }, apiKey, {
    purpose,
    executionId: ctx.executionId,
  });
};

export const parseJsonRecord = (raw: string) => {
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, "");
  const clean = candidate.endsWith("```") ? candidate.slice(0, -3).trimEnd() : candidate;
  try {
    return JSON.parse(clean) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const graphEvent = async (executionId: string, type: string, payload: unknown = {}) => {
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
      payload: payload as Prisma.InputJsonValue,
      correlationId: execution.correlationId,
    },
  });
};
