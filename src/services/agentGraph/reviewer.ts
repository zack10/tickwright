import { RenderedPrompt } from "../../prompts";
import { ToolRequest, ToolTurn } from "../llm/types";
import { REVIEW_TOOLS, ReviewVerdict, ToolContext } from "../sandbox/tools";
import { ToolCallRecorder, runRecordedTool } from "../sandbox/toolRunner";
import { AgentStep, runAgentLoop } from "./agentLoop";

const REVIEW_MAX_STEPS = 15;
// Its own cap, so a wandering review cannot spend the attempt's budget.
export const REVIEW_MAX_TOKENS = 40_000;
// Reviews are short: keep every read in full so files are not read twice.
const REVIEW_KEEP_RESULTS = REVIEW_MAX_STEPS;
const VERDICT_TOOL = REVIEW_TOOLS.filter((tool) => tool.name === "verdict");
const REVIEW_REMINDERS = {
  nudge: "Continue by calling a tool. When you have decided, call verdict.",
  budgetWarning: (used: string) =>
    `[Budget: ${used}. Call verdict now with what you have found; without a verdict the change is rejected.]`,
};

/**
 * A short read-only agent loop over the changed repository that ends with
 * the verdict tool. It fails closed: no verdict is a rejection.
 */
export const runReviewer = async (
  ctx: ToolContext,
  prompt: RenderedPrompt,
  deps: {
    generate: (request: ToolRequest) => Promise<ToolTurn>;
    recorder: ToolCallRecorder;
    maxTokens: number;
    deadline: number;
    onStep?: (step: AgentStep) => Promise<void>;
  },
): Promise<ReviewVerdict> => {
  let verdict: ReviewVerdict | undefined;
  const outcome = await runAgentLoop(
    {
      system: prompt.system,
      task: prompt.user,
      tools: REVIEW_TOOLS,
      budget: { maxSteps: REVIEW_MAX_STEPS, maxTokens: deps.maxTokens, deadline: deps.deadline },
      reminders: REVIEW_REMINDERS,
      finalTools: VERDICT_TOOL,
      keepRecentResults: REVIEW_KEEP_RESULTS,
    },
    {
      generate: deps.generate,
      runTool: async (call) => {
        const result = await runRecordedTool(ctx, call, deps.recorder, REVIEW_TOOLS);
        verdict ??= result.verdict;
        return result;
      },
      onStep: deps.onStep,
    },
  );
  return (
    verdict ?? {
      approved: false,
      issues: [`The reviewer did not reach a verdict: ${outcome.summary}`],
      summary: outcome.summary,
    }
  );
};


/**
 * What follows a review. The reviewer advises; a person decides: objections
 * go to the next attempt, and once attempts run out the verified change goes
 * to publish approval with them attached instead of being thrown away.
 */
export const reviewOutcome = (review: ReviewVerdict, canRetry: boolean) => {
  const suggestions = review.suggestions ?? [];
  if (review.approved) return { route: "artifact" as const, reviewSuggestions: suggestions, reviewObjections: [] as string[] };
  // A rejection with no issue listed still needs feedback.
  const issues = review.issues.length ? review.issues : [review.summary];
  return canRetry
    ? { route: "retry" as const, lastFailure: issues.join("\n") }
    : { route: "artifact" as const, reviewSuggestions: suggestions, reviewObjections: issues };
};
