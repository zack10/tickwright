import axios from "axios";
import { config } from "../../../config";
import { LLMOutputError } from "../errors";
import { groupMessages, replayable } from "../toolMessages";
import { LLMProvider, Model, TextResult, TokenUsage, ToolRequest, ToolTurn, UsageStats } from "../types";

// environment variable: GEMINI_API_KEY

interface GeminiModel {
  name: string;
  description?: string;
  displayName?: string;
  supportedGenerationMethods: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

const tokenUsage = (usage: UsageMetadata | undefined): TokenUsage => ({
  inputTokens: usage?.promptTokenCount ?? 0,
  // Thinking tokens are billed as output.
  outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
  reasoningTokens: usage?.thoughtsTokenCount ?? 0,
});

// shortcut: reasoningEffort is not mapped to Gemini's thinkingConfig yet (ignored), add it when a Gemini model is the benchmark default.
export class GeminiProvider implements LLMProvider {
  private readonly apiKey = process.env.GEMINI_API_KEY || "";

  /**
   * List available models from Gemini API
   * @param apiKey - API key (optional, uses environment variable if not provided)
   * @returns Array of available models
   */
  async listModels(apiKey?: string): Promise<Model[]> {
    const key = apiKey || this.apiKey;
    try {
      const response = await axios.get(
        "https://generativelanguage.googleapis.com/v1beta/models",
        {
          // Key in a header, not the URL, so it cannot leak via logged URLs.
          headers: { "x-goog-api-key": key },
          timeout: config.llmRequestTimeoutMs,
        },
      );
      const models = (response.data.models || []) as GeminiModel[];

      return models
        .filter((m) => m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => ({
          name: m.name.replace("models/", ""),
          description: m.description || m.displayName || m.name,
          type: "assistant",
          ctx_len: m.inputTokenLimit || 32768,
          n_ctx: m.inputTokenLimit || 32768,
          max_tokens: m.outputTokenLimit || 8192,
        }));
    } catch {
      throw new Error(
        "Gemini model discovery failed; verify the API key and provider availability",
      );
    }
  }

  /**
   * Generate content using Gemini API
   * @param model - Model name
   * @param prompt - System and user prompt
   * @param apiKey - API key (optional, uses environment variable if not provided)
   * @returns Generated content
   */
  async generateContent(
    model: string,
    prompt: { system?: string; user: string },
    apiKey?: string,
  ): Promise<TextResult> {
    const key = apiKey || this.apiKey;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const payload: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig: { maxOutputTokens: config.llmMaxOutputTokens },
    };

    if (prompt.system) {
      payload.system_instruction = {
        parts: [{ text: prompt.system }],
      };
    }

    const response = await axios.post(url, payload, {
      headers: { "x-goog-api-key": key },
      timeout: config.llmRequestTimeoutMs,
    });
    const data = response.data as {
      promptFeedback?: { blockReason?: string };
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: UsageMetadata;
    };
    if (data.promptFeedback?.blockReason)
      throw new LLMOutputError(
        "Gemini",
        `prompt blocked (${data.promptFeedback.blockReason})`,
      );
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS")
      throw new LLMOutputError("Gemini", "truncated at maxOutputTokens");
    if (
      candidate?.finishReason &&
      !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)
    )
      throw new LLMOutputError(
        "Gemini",
        `generation stopped (${candidate.finishReason})`,
      );
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
    if (!text.trim()) throw new LLMOutputError("Gemini", "empty response");
    return { text, usage: tokenUsage(data.usageMetadata) };
  }

  async generateWithTools(
    model: string,
    request: ToolRequest,
    apiKey?: string,
  ): Promise<ToolTurn> {
    const key = apiKey || this.apiKey;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const contents = groupMessages(request.messages).map((group) => {
      if (group.role === "user") return { role: "user", parts: [{ text: group.content }] };
      if (group.role === "tool")
        return {
          role: "user",
          parts: group.results.map((result) => ({
            functionResponse: {
              name: result.name,
              response: result.isError ? { error: result.content } : { result: result.content },
            },
          })),
        };
      // Replay the original parts: they carry thought signatures that
      // thinking models require back on every function call.
      const raw = replayable(group.message, "gemini");
      return {
        role: "model",
        parts: raw ?? [
          ...(group.message.content ? [{ text: group.message.content }] : []),
          ...group.message.toolCalls.map((call) => ({
            functionCall: { name: call.name, args: call.arguments },
          })),
        ],
      };
    });
    const payload: Record<string, unknown> = {
      contents,
      tools: [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ],
      generationConfig: { maxOutputTokens: config.llmMaxOutputTokens },
    };
    if (request.system) payload.system_instruction = { parts: [{ text: request.system }] };

    const response = await axios.post(url, payload, {
      headers: { "x-goog-api-key": key },
      timeout: config.llmRequestTimeoutMs,
    });
    const data = response.data as {
      promptFeedback?: { blockReason?: string };
      candidates?: Array<{
        finishReason?: string;
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
            functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: UsageMetadata;
    };
    if (data.promptFeedback?.blockReason)
      throw new LLMOutputError("Gemini", `prompt blocked (${data.promptFeedback.blockReason})`);
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS")
      throw new LLMOutputError("Gemini", "truncated at maxOutputTokens");
    // Function calls also finish with STOP; anything else (e.g.
    // MALFORMED_FUNCTION_CALL, SAFETY) is unusable.
    if (
      candidate?.finishReason &&
      !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)
    )
      throw new LLMOutputError("Gemini", `generation stopped (${candidate.finishReason})`);
    const parts = candidate?.content?.parts ?? [];
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("");
    // Older models give calls no id; number them so results can be matched.
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, index) => ({
        id: part.functionCall?.id ?? `call-${index}`,
        name: part.functionCall?.name ?? "",
        arguments: part.functionCall?.args ?? {},
      }));
    if (!text.trim() && toolCalls.length === 0)
      throw new LLMOutputError("Gemini", "empty response");
    return {
      message: {
        role: "assistant",
        content: text,
        toolCalls,
        raw: { provider: "gemini", content: parts },
      },
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: tokenUsage(data.usageMetadata),
    };
  }

  /**
   * Gemini does not expose account usage through this API
   * @param _apiKey - API key (unused for Gemini)
   * @returns Usage stats (always unavailable for Gemini)
   */
  async getUsage(_apiKey?: string): Promise<UsageStats> {
    return {
      available: false,
      message: "Gemini does not expose account usage through this API",
    };
  }
}
