import { RenderedPrompt } from "../../prompts";
import { ToolRequest, ToolTurn } from "../llm/types";
import { PLAN_TOOLS, ToolContext, executeTool } from "../sandbox/tools";
import { AgentStep, runAgentLoop } from "./agentLoop";

const PLAN_MAX_STEPS = 15;
// Its own cap, so a wandering plan cannot spend the run's budget.
export const PLAN_MAX_TOKENS = 80_000;
// Plans are short: keep every read in full so files are not read twice.
const PLAN_KEEP_RESULTS = PLAN_MAX_STEPS;
const SUBMIT_TOOL = PLAN_TOOLS.filter((tool) => tool.name === "submit_plan");
const PLAN_REMINDERS = {
  nudge: "Continue by calling a tool. When you have read the code the ticket is about, call submit_plan.",
  budgetWarning: (used: string) => `[Budget: ${used}. Call submit_plan now with what you have found.]`,
};

/**
 * A short read-only agent loop over the repository that ends with the
 * submit_plan tool, so the plan is written from the code as it is and not
 * from a cut sample of it. Returns the plan as the model gave it, or
 * undefined when the loop ended without one.
 */
export const runPlanner = async (
  ctx: ToolContext,
  prompt: RenderedPrompt,
  deps: {
    generate: (request: ToolRequest) => Promise<ToolTurn>;
    maxTokens: number;
    deadline: number;
    onStep?: (step: AgentStep) => Promise<void>;
  },
): Promise<Record<string, unknown> | undefined> => {
  let plan: Record<string, unknown> | undefined;
  await runAgentLoop(
    {
      system: prompt.system,
      task: prompt.user,
      tools: PLAN_TOOLS,
      budget: { maxSteps: PLAN_MAX_STEPS, maxTokens: deps.maxTokens, deadline: deps.deadline },
      reminders: PLAN_REMINDERS,
      finalTools: SUBMIT_TOOL,
      keepRecentResults: PLAN_KEEP_RESULTS,
    },
    {
      generate: deps.generate,
      runTool: async (call) => {
        const result = await executeTool(ctx, call.name, call.arguments, PLAN_TOOLS);
        plan ??= result.plan;
        return result;
      },
      onStep: deps.onStep,
    },
  );
  return plan;
};
