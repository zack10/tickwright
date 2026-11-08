import { ChatMessage } from "./types";

type ToolResult = Extract<ChatMessage, { role: "tool" }>;
type Assistant = Extract<ChatMessage, { role: "assistant" }>;

export type MessageGroup =
  | { role: "user"; content: string }
  | { role: "assistant"; message: Assistant }
  | { role: "tool"; results: ToolResult[] };

/**
 * Collapses consecutive tool results into one group. Anthropic and Gemini
 * expect all results of one assistant turn in a single user message.
 */
export const groupMessages = (messages: ChatMessage[]): MessageGroup[] => {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (message.role === "tool") {
      if (last?.role === "tool") last.results.push(message);
      else groups.push({ role: "tool", results: [message] });
    } else if (message.role === "assistant") {
      groups.push({ role: "assistant", message });
    } else {
      groups.push({ role: "user", content: message.content });
    }
  }
  return groups;
};

/** The raw reply to replay, only when it came from this same provider. */
export const replayable = (message: Assistant, provider: string): unknown =>
  message.raw?.provider === provider ? message.raw.content : undefined;
