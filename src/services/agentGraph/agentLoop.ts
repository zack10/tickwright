import { ChatMessage, ToolCall, ToolDefinition, ToolRequest, ToolTurn } from "../llm/types";
import { ToolOutcome } from "../sandbox/tools";

/**
 * The act → observe → decide loop: the model picks tools, sees their
 * results and decides the next step, until it calls `finish` or a budget
 * runs out. Model, tools and events are passed in, so the loop itself has
 * no I/O and can be tested with a scripted model.
 */

export interface AgentLoopBudget {
  maxSteps: number;
  /** Input + output tokens this loop may spend. */
  maxTokens: number;
  /** Epoch milliseconds after which no new model call starts. */
  deadline: number;
  /**
   * A lower limit for this attempt (its share of the budget). Reaching it
   * stops an attempt that has changed nothing; one with changes is told to
   * wrap up and gets `graceSteps` more steps in the same conversation, so a
   * nearly finished change is not restarted from scratch.
   */
  soft?: { maxTokens: number; deadline: number; graceSteps?: number };
}

export type AgentStopReason =
  | "done"
  | "blocked"
  | "max_steps"
  | "max_tokens"
  | "timeout"
  | "no_finish";

export interface AgentStep {
  step: number;
  text: string;
  toolCalls: Array<{ call: ToolCall; outcome: ToolOutcome }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentLoopResult {
  stopReason: AgentStopReason;
  /** The agent's summary for done/blocked; what ran out otherwise. */
  summary: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentLoopDeps {
  generate: (request: ToolRequest) => Promise<ToolTurn>;
  runTool: (call: ToolCall) => Promise<ToolOutcome>;
  onStep?: (step: AgentStep) => Promise<void>;
  /** Whether the attempt has changed any files, asked at the soft limit. */
  hasChanges?: () => Promise<boolean>;
  now?: () => number;
}

// Replies without a tool call that are answered with a reminder before the
// loop gives up (models sometimes describe the fix instead of making it).
const MAX_NUDGES = 2;
const NUDGE =
  "Continue by calling a tool. When the change is complete, or the ticket cannot or should not be done, call finish.";

// Once this share of the step or token budget is used, the agent is told
// once, so a finished change is not lost to a budget stop.
const BUDGET_WARNING_SHARE = 0.8;
const budgetWarning = (used: string) =>
  `[Budget: ${used}. If the change is complete and its checks pass, call finish now; otherwise finish with what you have and say what is left.]`;

const DEFAULT_GRACE_STEPS = 3;
const wrapUp = (steps: number) =>
  `[This attempt has used its share of the budget. You have ${steps} more steps: do not explore further. Run the checks on your change and call finish; if it is not complete, finish with what you have and say what is left.]`;

// At least the most recent KEEP_RECENT_RESULTS tool results are shown in
// full; older ones are shortened to a stub, and the model can call the tool
// again if it needs them. Shortening happens in batches of that size, not one
// result per step: between batches the conversation only grows at the end,
// so providers can serve the unchanged start from their prompt cache.
const KEEP_RECENT_RESULTS = 8;
const STUB_THRESHOLD_CHARS = 400;

// The same call made this many times with the same result is pointed out,
// since an agent repeating itself is stuck rather than making progress.
const REPEAT_WARNING_CALLS = 3;
const repeatWarning = (count: number) =>
  `[You have made this exact call ${count} times with the same result. Repeating it will not show anything new: use what you already have, or try a different approach.]`;

const callKey = (call: ToolCall) => {
  const sorted = Object.keys(call.arguments).sort().map((key) => [key, call.arguments[key]]);
  return `${call.name}:${JSON.stringify(sorted)}`;
};

interface SeenResult {
  output: string;
  /** Index in the conversation of the message holding the full output. */
  messageIndex: number;
  step: number;
  count: number;
}

/** How many of `total` tool results, oldest first, are shortened: whole batches once 2 x keepRecent have built up. */
const shortenedResults = (total: number, keepRecent: number) =>
  total < 2 * keepRecent ? 0 : Math.floor((total - keepRecent) / keepRecent) * keepRecent;

/** Position of each tool result among the tool results, by message index. */
const toolPositions = (messages: ChatMessage[]) => {
  const positions = new Map<number, number>();
  messages.forEach((message, index) => {
    if (message.role === "tool") positions.set(index, positions.size);
  });
  return positions;
};

/**
 * Whether the tool result at `index` will still be shown in full once one
 * more tool result is added (see compactMessages).
 */
const stillShownInFull = (messages: ChatMessage[], index: number, keepRecent = KEEP_RECENT_RESULTS) => {
  if (messages[index].content.length <= STUB_THRESHOLD_CHARS) return true;
  const positions = toolPositions(messages);
  return (positions.get(index) ?? 0) >= shortenedResults(positions.size + 1, keepRecent);
};

/**
 * Shortens old tool results so long runs fit the context window. Messages
 * are never removed: every tool call keeps its result, which all providers
 * require, and assistant turns keep their raw content for replay.
 */
export const compactMessages = (
  messages: ChatMessage[],
  keepRecent = KEEP_RECENT_RESULTS,
): ChatMessage[] => {
  const positions = toolPositions(messages);
  const shortened = shortenedResults(positions.size, keepRecent);
  return messages.map((message, index) => {
    const position = positions.get(index);
    if (message.role !== "tool" || position === undefined || position >= shortened || message.content.length <= STUB_THRESHOLD_CHARS)
      return message;
    const firstLine = message.content.split("\n", 1)[0].slice(0, 200);
    return {
      ...message,
      content: `${firstLine}\n[older ${message.name} output removed to save context (${message.content.length} characters); call the tool again if you need it]`,
    };
  });
};

/**
 * What one attempt may spend of what is left: every attempt but the last
 * gets `share` of it, so a first attempt that wanders still leaves a retry
 * room to work. What an attempt does not use stays for the next one.
 */
export const attemptAllowance = (left: number, attemptNumber: number, maxAttempts: number, share: number) =>
  attemptNumber >= maxAttempts ? left : Math.floor(left * share);

const MAX_LOG_CHARS = 8000;
const LOG_TEXT_CHARS = 300;
const LOG_INPUT_CHARS = 200;
const LOG_OUTPUT_CHARS = 400;
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;

/**
 * A short account of what an attempt did, step by step, for the analysis
 * that guides the next attempt. When it is too long, the earliest steps
 * are left out: how the attempt ended matters most.
 */
export const describeAttempt = (steps: AgentStep[], maxChars = MAX_LOG_CHARS) => {
  const entries = steps.map((step) => {
    const lines = [`Step ${step.step}:${step.text.trim() ? ` ${clip(step.text.trim(), LOG_TEXT_CHARS)}` : ""}`];
    for (const { call, outcome } of step.toolCalls)
      lines.push(
        `  ${call.name} ${clip(JSON.stringify(call.arguments), LOG_INPUT_CHARS)} -> ${outcome.status}: ${clip(outcome.output.trim(), LOG_OUTPUT_CHARS)}`,
      );
    return lines.join("\n");
  });
  const kept: string[] = [];
  let length = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (length + entries[index].length > maxChars) {
      kept.unshift(`(${index + 1} earlier steps left out)`);
      break;
    }
    kept.unshift(entries[index]);
    length += entries[index].length + 1;
  }
  return kept.join("\n");
};

export const runAgentLoop = async (
  input: {
    system: string;
    task: string;
    tools: ToolDefinition[];
    budget: AgentLoopBudget;
    /** Replaces the reminders that name finish, for a loop that ends with another tool. */
    reminders?: { nudge: string; budgetWarning: (used: string) => string };
    /**
     * The only tools offered on the last step, or once the token warning
     * share is used, so the loop ends with an answer instead of running out.
     */
    finalTools?: ToolDefinition[];
    /** Tool results shown in full; older ones are shortened (see compactMessages). */
    keepRecentResults?: number;
  },
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> => {
  const now = deps.now ?? Date.now;
  const { budget } = input;
  const keepRecent = input.keepRecentResults ?? KEEP_RECENT_RESULTS;
  const messages: ChatMessage[] = [{ role: "user", content: input.task }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  // The last call's tokens: the next one costs at least as much, since the
  // conversation only grows.
  let lastStepTokens = 0;
  let steps = 0;
  let nudges = 0;
  let warned = false;
  const seen = new Map<string, SeenResult>();
  // A result identical to one the model can still see in full is replaced
  // by a short note (a file it reads again unchanged, a check that fails
  // the same way). Once the earlier copy would be shortened, the full
  // output is sent again, as compactMessages promises.
  const repeatAware = (call: ToolCall, output: string): string => {
    const key = callKey(call);
    const previous = seen.get(key);
    const index = messages.length;
    if (!previous || previous.output !== output) {
      seen.set(key, { output, messageIndex: index, step: steps, count: 1 });
      return output;
    }
    previous.count++;
    const warning = previous.count >= REPEAT_WARNING_CALLS ? `\n${repeatWarning(previous.count)}` : "";
    if (stillShownInFull(messages, previous.messageIndex, keepRecent))
      return `[Same result as your identical ${call.name} call at step ${previous.step}, which is shown above; nothing has changed since.]${warning}`;
    previous.messageIndex = index;
    previous.step = steps;
    return warning ? `${output}\n\n${warning.trimStart()}` : output;
  };
  const result = (stopReason: AgentStopReason, summary: string): AgentLoopResult => ({
    stopReason,
    summary,
    steps,
    usage: { ...usage },
  });

  // What the agent is warned against: its share when it has one.
  const limitTokens = budget.soft ? Math.min(budget.soft.maxTokens, budget.maxTokens) : budget.maxTokens;
  // Steps left after the soft limit was reached; undefined before that.
  let graceLeft: number | undefined;
  let softStop: { reason: "max_tokens" | "timeout"; summary: string } | undefined;

  for (; ;) {
    // Budgets are checked before each model call, so a call that is
    // started always gets to finish and record its tool results.
    if (steps >= budget.maxSteps)
      return result("max_steps", `Stopped after ${budget.maxSteps} steps without calling finish.`);
    if (usage.inputTokens + usage.outputTokens >= budget.maxTokens)
      return result("max_tokens", `Stopped after using ${usage.inputTokens + usage.outputTokens} of ${budget.maxTokens} tokens.`);
    if (now() >= budget.deadline)
      return result("timeout", "Stopped: the execution's time budget ran out.");

    if (budget.soft && graceLeft === undefined) {
      const tokens = usage.inputTokens + usage.outputTokens;
      if (tokens >= budget.soft.maxTokens)
        softStop = { reason: "max_tokens", summary: `Stopped after using ${tokens} of this attempt's ${budget.soft.maxTokens} tokens.` };
      else if (now() >= budget.soft.deadline)
        softStop = { reason: "timeout", summary: "Stopped: this attempt's share of the time budget ran out." };
      if (softStop) {
        if (!(await deps.hasChanges?.())) return result(softStop.reason, softStop.summary);
        graceLeft = budget.soft.graceSteps ?? DEFAULT_GRACE_STEPS;
        // Tool results end every step but a nudged one, which ends with the nudge.
        const last = messages[messages.length - 1];
        if (last.role === "tool" || last.role === "user") last.content += `\n\n${wrapUp(graceLeft)}`;
        else messages.push({ role: "user", content: wrapUp(graceLeft) });
      }
    }
    if (softStop && graceLeft !== undefined) {
      if (graceLeft <= 0)
        return result(softStop.reason, `${softStop.summary} The ${budget.soft?.graceSteps ?? DEFAULT_GRACE_STEPS} wrap-up steps ended without finish.`);
      graceLeft--;
    }

    steps++;
    const used = usage.inputTokens + usage.outputTokens;
    // Also the last call when this one and the next would not both fit.
    const lastCall =
      steps >= budget.maxSteps ||
      used >= budget.maxTokens * BUDGET_WARNING_SHARE ||
      used + 2 * lastStepTokens > budget.maxTokens;
    const turn = await deps.generate({
      system: input.system,
      messages: compactMessages(messages, keepRecent),
      tools: lastCall && input.finalTools ? input.finalTools : input.tools,
    });
    usage.inputTokens += turn.usage?.inputTokens ?? 0;
    usage.outputTokens += turn.usage?.outputTokens ?? 0;
    lastStepTokens = (turn.usage?.inputTokens ?? 0) + (turn.usage?.outputTokens ?? 0);
    messages.push(turn.message);
    const stepUsage = { inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 };

    if (turn.toolCalls.length === 0) {
      await deps.onStep?.({ step: steps, text: turn.text, toolCalls: [], usage: stepUsage });
      if (nudges >= MAX_NUDGES)
        return result("no_finish", "The agent stopped calling tools without calling finish.");
      nudges++;
      messages.push({ role: "user", content: input.reminders?.nudge ?? NUDGE });
      continue;
    }

    const ran: AgentStep["toolCalls"] = [];
    let finish: ToolOutcome["finish"];
    for (const call of turn.toolCalls) {
      const outcome = await deps.runTool(call);
      ran.push({ call, outcome });
      if (outcome.finish) {
        // Calls after finish in the same turn are not run.
        finish = outcome.finish;
        break;
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: repeatAware(call, outcome.output),
        isError: outcome.status !== "COMPLETED",
      });
    }
    await deps.onStep?.({ step: steps, text: turn.text, toolCalls: ran, usage: stepUsage });
    if (finish) return result(finish.status, finish.summary);

    // The warning goes into the last tool result: a separate user message
    // after tool results is not accepted by every provider.
    const tokens = usage.inputTokens + usage.outputTokens;
    if (!warned && graceLeft === undefined && (steps >= budget.maxSteps * BUDGET_WARNING_SHARE || tokens >= limitTokens * BUDGET_WARNING_SHARE)) {
      warned = true;
      const last = messages[messages.length - 1];
      if (last.role === "tool")
        last.content += `\n\n${(input.reminders?.budgetWarning ?? budgetWarning)(`${steps} of ${budget.maxSteps} steps and ${tokens} of ${limitTokens} tokens used`)}`;
    }
  }
};
