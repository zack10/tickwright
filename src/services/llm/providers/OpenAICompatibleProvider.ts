import axios from "axios";
import { config } from "../../../config";
import { LLMOutputError } from "../errors";
import { replayable } from "../toolMessages";
import { LLMProvider, Model, ReasoningEffort, TextPrompt, TextResult, TokenUsage, ToolRequest, ToolTurn, UsageStats } from "../types";

interface OpenAIModel {
  id: string;
}

/** One configured OpenAI-compatible endpoint (OpenAI, Groq, Mistral, Ollama, ...). */
export interface OpenAICompatibleProfile {
  key: string;
  label: string;
  /** Validated by the registry; never taken from API input. */
  baseUrl: string;
  /** Server-side key; an agent's own key takes precedence. */
  apiKey: string;
  supportsTools: boolean;
  modelPrefixes?: string[];
  /**
   * Endpoint for tool calls: "chat" (/chat/completions, every compatible API)
   * or "responses" (/responses, OpenAI's own; its newest models reject tools
   * with reasoning on chat completions). Plain text always uses chat.
   */
  toolsApi?: "chat" | "responses";
}

/** Marks an assistant turn's raw output items, replayed only to the Responses API. */
const RESPONSES_RAW = "openai-responses";

interface ResponsesItem {
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

const responsesUsage = (usage: ResponsesUsage | undefined): TokenUsage | undefined => {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
};

// Context and output limits for well-known models; others get conservative defaults.
const KNOWN_MODELS: Record<string, { ctx: number; max: number }> = {
  "gpt-4o": { ctx: 128000, max: 4096 },
  "gpt-4o-mini": { ctx: 128000, max: 16384 },
  "gpt-4-turbo": { ctx: 128000, max: 4096 },
  "o1-preview": { ctx: 128000, max: 32768 },
};

/**
 * Provider for any API that speaks OpenAI's /models and /chat/completions
 * format. One instance per configured profile, so several vendors can be
 * used side by side without new code.
 */
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

// Only sent when set: models without reasoning reject the parameter.
const reasoning = (effort: ReasoningEffort | undefined) => (effort ? { reasoning_effort: effort } : {});

const tokenUsage = (usage: ChatUsage | undefined): TokenUsage => ({
  inputTokens: usage?.prompt_tokens ?? 0,
  outputTokens: usage?.completion_tokens ?? 0,
  cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
});

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly profile: OpenAICompatibleProfile) {}

  private headers(apiKey?: string): Record<string, string> {
    const key = apiKey || this.profile.apiKey;
    // Keyless local servers (e.g. Ollama) get no Authorization header.
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /**
   * List the models the endpoint offers
   * @param apiKey - API key (optional, uses the profile's key if not provided)
   * @returns Array of available models
   */
  async listModels(apiKey?: string): Promise<Model[]> {
    const { label, modelPrefixes } = this.profile;
    try {
      const response = await axios.get(`${this.profile.baseUrl}/models`, {
        headers: this.headers(apiKey),
        timeout: config.llmRequestTimeoutMs,
      });

      return (response.data.data as OpenAIModel[])
        .filter(
          (model) => !modelPrefixes || modelPrefixes.some((prefix) => model.id.startsWith(prefix)),
        )
        .map((model) => {
          const meta = KNOWN_MODELS[model.id] || { ctx: 8192, max: 4096 };
          return {
            name: model.id,
            description: `${label} ${model.id} model`,
            type: "assistant",
            ctx_len: meta.ctx,
            n_ctx: meta.ctx,
            max_tokens: meta.max,
          };
        });
    } catch {
      throw new Error(
        `${label} model discovery failed; verify the API key, base URL, and provider availability`,
      );
    }
  }

  /**
   * Generate content through the chat completions endpoint
   * @param model - Model name
   * @param prompt - System and user prompt
   * @param apiKey - API key (optional, uses the profile's key if not provided)
   * @returns Generated content
   */
  async generateContent(
    model: string,
    prompt: TextPrompt,
    apiKey?: string,
  ): Promise<TextResult> {
    const { label } = this.profile;
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (prompt.system) {
      messages.push({ role: "system", content: prompt.system });
    }
    messages.push({ role: "user", content: prompt.user });

    const response = await axios.post(
      `${this.profile.baseUrl}/chat/completions`,
      {
        model,
        messages,
        ...reasoning(prompt.reasoningEffort),
      },
      {
        headers: this.headers(apiKey),
        timeout: config.llmRequestTimeoutMs,
      },
    );
    const choice = response.data.choices?.[0] as
      | { finish_reason?: string; message?: { content?: string | null } }
      | undefined;
    if (choice?.finish_reason === "length")
      throw new LLMOutputError(label, "truncated at the token limit");
    if (choice?.finish_reason === "content_filter")
      throw new LLMOutputError(label, "blocked by content filter");
    const text = choice?.message?.content ?? "";
    if (!text.trim()) throw new LLMOutputError(label, "empty response");
    return { text, usage: tokenUsage(response.data.usage as ChatUsage | undefined) };
  }

  async generateWithTools(
    model: string,
    request: ToolRequest,
    apiKey?: string,
  ): Promise<ToolTurn> {
    if (this.profile.toolsApi === "responses") return this.generateWithResponses(model, request, apiKey);
    const { label } = this.profile;
    const messages: Array<Record<string, unknown>> = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    for (const message of request.messages) {
      if (message.role === "user") messages.push({ role: "user", content: message.content });
      else if (message.role === "tool")
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.isError ? `Error: ${message.content}` : message.content,
        });
      else
        messages.push({
          role: "assistant",
          content: message.content || null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        });
    }

    const response = await axios.post(
      `${this.profile.baseUrl}/chat/completions`,
      {
        model,
        messages,
        ...reasoning(request.reasoningEffort),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      },
      {
        headers: this.headers(apiKey),
        timeout: config.llmRequestTimeoutMs,
      },
    );
    const data = response.data as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: ChatUsage;
    };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length")
      throw new LLMOutputError(label, "truncated at the token limit");
    if (choice?.finish_reason === "content_filter")
      throw new LLMOutputError(label, "blocked by content filter");
    const text = choice?.message?.content ?? "";
    const toolCalls = (choice?.message?.tool_calls ?? []).map((call, index) => {
      let args: unknown;
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        throw new LLMOutputError(label, `tool call ${call.function?.name ?? index} has invalid JSON arguments`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new LLMOutputError(label, `tool call ${call.function?.name ?? index} arguments are not an object`);
      return {
        id: call.id || `call-${index}`,
        name: call.function?.name ?? "",
        arguments: args as Record<string, unknown>,
      };
    });
    if (!text.trim() && toolCalls.length === 0)
      throw new LLMOutputError(label, "empty response");
    return {
      message: { role: "assistant", content: text, toolCalls },
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: tokenUsage(data.usage),
    };
  }

  /**
   * Tool turn through the Responses API. Stateless (`store: false`): the
   * whole conversation is sent each time, and this provider's own earlier
   * output items (reasoning, encrypted, and function calls) are replayed
   * unchanged so the model keeps its reasoning between turns.
   */
  private async generateWithResponses(model: string, request: ToolRequest, apiKey?: string): Promise<ToolTurn> {
    const { label } = this.profile;
    const input: unknown[] = [];
    for (const message of request.messages) {
      if (message.role === "user") input.push({ role: "user", content: message.content });
      else if (message.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.isError ? `Error: ${message.content}` : message.content,
        });
      else {
        const raw = replayable(message, RESPONSES_RAW);
        if (Array.isArray(raw)) input.push(...raw);
        else {
          if (message.content) input.push({ role: "assistant", content: message.content });
          for (const call of message.toolCalls)
            input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
        }
      }
    }

    const response = await axios.post(
      `${this.profile.baseUrl}/responses`,
      {
        model,
        ...(request.system ? { instructions: request.system } : {}),
        input,
        tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
        ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
        store: false,
        include: ["reasoning.encrypted_content"],
      },
      { headers: this.headers(apiKey), timeout: config.llmRequestTimeoutMs },
    );
    const data = response.data as {
      status?: string;
      incomplete_details?: { reason?: string };
      output?: ResponsesItem[];
      usage?: ResponsesUsage;
    };
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason;
      if (reason === "max_output_tokens") throw new LLMOutputError(label, "truncated at the token limit");
      if (reason === "content_filter") throw new LLMOutputError(label, "blocked by content filter");
      throw new LLMOutputError(label, `incomplete response (${reason ?? "no reason given"})`);
    }
    const output = data.output ?? [];
    const parts = output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
    if (parts.some((part) => part.type === "refusal")) throw new LLMOutputError(label, "refused the request");
    const text = parts.filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
    const toolCalls = output
      .filter((item) => item.type === "function_call")
      .map((item, index) => {
        let args: unknown;
        try {
          args = JSON.parse(item.arguments || "{}");
        } catch {
          throw new LLMOutputError(label, `tool call ${item.name ?? index} has invalid JSON arguments`);
        }
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new LLMOutputError(label, `tool call ${item.name ?? index} arguments are not an object`);
        return { id: item.call_id || `call-${index}`, name: item.name ?? "", arguments: args as Record<string, unknown> };
      });
    if (!text.trim() && toolCalls.length === 0) throw new LLMOutputError(label, "empty response");
    return {
      message: { role: "assistant", content: text, toolCalls, raw: { provider: RESPONSES_RAW, content: output } },
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: responsesUsage(data.usage),
    };
  }

  /**
   * Get usage information (not exposed by OpenAI-compatible APIs)
   * @param _apiKey - API key (unused)
   * @returns Usage stats (always unavailable)
   */
  async getUsage(_apiKey?: string): Promise<UsageStats> {
    return {
      available: false,
      message: "Usage is not queried through inference requests",
    };
  }
}
