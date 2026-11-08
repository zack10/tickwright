export interface LLMProvider {
  listModels(apiKey?: string): Promise<Model[]>;
  generateContent(
    model: string,
    prompt: TextPrompt,
    apiKey?: string,
  ): Promise<TextResult>;
  generateWithTools(
    model: string,
    request: ToolRequest,
    apiKey?: string,
  ): Promise<ToolTurn>;
  getUsage(apiKey?: string): Promise<UsageStats>;
}

/**
 * A tool the model may call. `parameters` is a JSON Schema object; keep to
 * the subset every provider accepts (type, properties, required, items,
 * enum, description), since Gemini rejects the rest.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Provider-neutral conversation. An assistant message carries the
 * provider's raw reply in `raw`, which that provider replays unchanged:
 * Anthropic thinking blocks and Gemini thought signatures must come back
 * exactly as received, or the next request is rejected.
 */
export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      raw?: { provider: string; content: unknown };
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
    };

/**
 * How long a reasoning model thinks before it answers. Unset leaves the
 * model's own default; a provider without such a setting ignores it.
 */
export type ReasoningEffort = "low" | "medium" | "high";

export interface TextPrompt {
  system?: string;
  user: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ToolRequest {
  system?: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  reasoningEffort?: ReasoningEffort;
}

export interface TokenUsage {
  /** All input tokens, including those served from the provider's cache. */
  inputTokens: number;
  /** All output tokens, including reasoning. */
  outputTokens: number;
  /** Input tokens read from the provider's prompt cache (billed at a discount). */
  cachedInputTokens?: number;
  /** Output tokens spent on reasoning. */
  reasoningTokens?: number;
}

export interface TextResult {
  text: string;
  usage?: TokenUsage;
}

export interface ToolTurn {
  /** Append this to the conversation before sending tool results. */
  message: Extract<ChatMessage, { role: "assistant" }>;
  text: string;
  toolCalls: ToolCall[];
  /** "tool_use": run the calls and send their results; "end_turn": done. */
  stopReason: "tool_use" | "end_turn";
  usage?: TokenUsage;
}

export interface Model {
  name: string;
  description: string;
  type: "system" | "user" | "assistant";
  ctx_len: number;
  n_ctx: number;
  max_tokens: number;
  prices?: {
    input_price: number;
    output_price: number;
  };
}

export interface UsageStats {
  available: boolean;
  message: string;
}
