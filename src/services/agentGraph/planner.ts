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
 * No plan to show a person. The queue retries the plan step, and after the last
 * try the ticket is told this message (an empty plan was posted for approval: row 83).
 */
export class PlanNotWrittenError extends Error {
  name = "PlanNotWrittenError";
}

/**
 * A short read-only agent loop over the repository that ends with the
 * submit_plan tool, so the plan is written from the code as it is and not
 * from a cut sample of it. Returns the plan as the model gave it; throws
 * PlanNotWrittenError, with the last refusal, when the loop ended without one.
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
): Promise<Record<string, unknown>> => {
  let plan: Record<string, unknown> | undefined;
  let refusal: string | undefined;
  const ended = await runAgentLoop(
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
        // The latest wins: a refused plan is kept until a corrected one comes.
        plan = result.plan ?? plan;
        if (call.name === "submit_plan" && !result.plan) refusal = result.output;
        return result;
      },
      onStep: deps.onStep,
    },
  );
  if (!plan) throw new PlanNotWrittenError(`Could not write a plan: ${(refusal ?? ended.summary).replace(/\.\s*$/, "")}`);
  return plan;
};
