import axios from "axios";
import { config } from "../../../config";
import { LLMOutputError } from "../errors";
import { groupMessages, replayable } from "../toolMessages";
import { LLMProvider, Model, TextResult, TokenUsage, ToolRequest, ToolTurn, UsageStats } from "../types";

interface AnthropicModel {
  id: string;
  display_name?: string;
}

interface MessagesUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// input_tokens excludes cache reads and writes; inputTokens counts all input, as for other providers.
const tokenUsage = (usage: MessagesUsage | undefined): TokenUsage => ({
  inputTokens:
    (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
  outputTokens: usage?.output_tokens ?? 0,
  cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
});

export class AnthropicProvider implements LLMProvider {
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || "";

  async listModels(apiKey?: string): Promise<Model[]> {
    const key = apiKey || this.apiKey;
    try {
      const response = await axios.get("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        timeout: config.llmRequestTimeoutMs,
      });

      return ((response.data.data || []) as AnthropicModel[]).map((model) => ({
        name: model.id,
        description: model.display_name || `Anthropic ${model.id}`,
        type: "assistant",
        ctx_len: 200000,
        n_ctx: 200000,
        max_tokens: 4096,
      }));
    } catch {
      throw new Error(
        "Anthropic model discovery failed; verify the API key and provider availability",
      );
    }
  }

  async generateContent(
    model: string,
    prompt: { system?: string; user: string },
    apiKey?: string,
  ): Promise<TextResult> {
    const key = apiKey || this.apiKey;
    const url = "https://api.anthropic.com/v1/messages";
    const payload: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt.user }],
      max_tokens: config.llmMaxOutputTokens,
    };

    if (prompt.system) {
      payload.system = prompt.system;
    }

    const response = await axios.post(url, payload, {
      timeout: config.llmRequestTimeoutMs,
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    });
    const data = response.data as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: MessagesUsage;
    };
    if (data.stop_reason === "max_tokens")
      throw new LLMOutputError("Anthropic", "truncated at max_tokens");
    if (data.stop_reason === "refusal")
      throw new LLMOutputError("Anthropic", "request was refused");
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (!text.trim()) throw new LLMOutputError("Anthropic", "empty response");
    return {
      text,
      usage: tokenUsage(data.usage),
    };
  }

  async generateWithTools(
    model: string,
    request: ToolRequest,
    apiKey?: string,
  ): Promise<ToolTurn> {
    const key = apiKey || this.apiKey;
    const messages = groupMessages(request.messages).map((group) => {
      if (group.role === "user") return { role: "user", content: group.content };
      if (group.role === "tool")
        return {
          role: "user",
          content: group.results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.toolCallId,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })),
        };
      // Replay the original blocks (including thinking) when we have them.
      const raw = replayable(group.message, "anthropic");
      return {
        role: "assistant",
        content: raw ?? [
          ...(group.message.content ? [{ type: "text", text: group.message.content }] : []),
          ...group.message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        ],
      };
    });
    const payload: Record<string, unknown> = {
      model,
      messages,
      max_tokens: config.llmMaxOutputTokens,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    };
    if (request.system) payload.system = request.system;
    // Anthropic caches only up to a marked block: mark the end of the request,
    // so the next call in the loop reads tools, system and history from cache.
    const last = messages[messages.length - 1] as unknown as { content: string | Array<Record<string, unknown>> } | undefined;
    if (last) {
      const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
      if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
      last.content = blocks;
    }

    const response = await axios.post("https://api.anthropic.com/v1/messages", payload, {
      timeout: config.llmRequestTimeoutMs,
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    });
    const data = response.data as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: MessagesUsage;
    };
    if (data.stop_reason === "max_tokens")
      throw new LLMOutputError("Anthropic", "truncated at max_tokens");
    if (data.stop_reason === "refusal")
      throw new LLMOutputError("Anthropic", "request was refused");
    const content = data.content ?? [];
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const toolCalls = content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: (block.input ?? {}) as Record<string, unknown>,
      }));
    if (!text.trim() && toolCalls.length === 0)
      throw new LLMOutputError("Anthropic", "empty response");
    return {
      message: {
        role: "assistant",
        content: text,
        toolCalls,
        raw: { provider: "anthropic", content },
      },
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: tokenUsage(data.usage),
    };
  }

  async getUsage(_apiKey?: string): Promise<UsageStats> {
    return {
      available: false,
      message: "Usage is not queried through inference requests",
    };
  }
}
