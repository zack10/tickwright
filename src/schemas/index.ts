import { z } from "zod";
import { EXECUTION_PROMPTS, ExecutionPromptName } from "../prompts";
import { getProviderRegistry } from "../services/llm/registry";

const uuid = z.string().uuid();

// Any provider in the registry: built-ins plus LLM_PROVIDERS profiles.
const providerKey = z
  .string()
  .refine((key) => getProviderRegistry().has(key), {
    message: "Unknown LLM provider; see GET /api/llm/providers",
  });

// Agent schemas
// config is free-form; the parts the server reads are checked.
const callKind = z.enum(Object.keys(EXECUTION_PROMPTS) as [ExecutionPromptName, ...ExecutionPromptName[]]);
const callModel = z
  .object({ provider: providerKey, model: z.string().min(1), apiKey: z.string().min(1).optional() })
  .strict();
const agentConfig = z
  .object({
    // A separate model for reviewing diffs; default the agent's own. Same as models.review and models.reviewer.
    reviewer: callModel.optional(),
    // A model per kind of execution call, e.g. { "triage": { "provider": "openai", "model": "gpt-5-nano" } }.
    models: z.record(callKind, callModel).optional(),
    // Reasoning effort per kind of execution call, e.g. { "triage": "low" }; unset keeps the model's default.
    reasoningEffort: z.record(callKind, z.enum(["low", "medium", "high"])).optional(),
  })
  .passthrough();

export const createAgentSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
    config: agentConfig.optional(),
    projectId: uuid.optional(),
    provider: providerKey.optional(),
    model: z.string().min(1).optional(),
    baseInstructions: z.string().max(20_000).optional(),
  }),
});

export const updateAgentSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    config: agentConfig.optional(),
    projectId: uuid.optional(),
    provider: providerKey.optional(),
    model: z.string().min(1).optional(),
    baseInstructions: z.string().max(20_000).optional(),
  }),
});

// Skill schemas
export const createSkillSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
    logic: z.string().min(1, "Logic is required"),
  }),
});

export const updateSkillSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    logic: z.string().min(1).optional(),
  }),
});

export const assignSkillSchema = z.object({
  body: z.object({
    agentId: uuid,
    skillId: uuid,
  }),
});

// Task schemas
export const createTaskSchema = z.object({
  headers: z
    .object({
      "idempotency-key": z.string().min(8).max(200).optional(),
    })
    .passthrough(),
  body: z.object({
    agentId: uuid,
    payload: z.record(z.unknown()),
  }),
});

export const discoverProviderSchema = z.object({
  body: z.object({
    provider: providerKey,
    apiKey: z.string().min(1),
  }),
});

export const providerQuerySchema = z.object({
  query: z.object({ provider: providerKey }),
});

// Project schemas
export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional(),
    techStack: z.string().optional(),
    architectureDecisions: z.string().optional(),
    contextData: z.record(z.unknown()).optional(),
  }),
});

export const updateProjectSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    techStack: z.string().optional(),
    architectureDecisions: z.string().optional(),
    contextData: z.record(z.unknown()).optional(),
  }),
});

// Shared param schemas
export const idParamSchema = z.object({
  params: z.object({ id: uuid }),
});
