import type { ModelCapabilities, ModelProvider } from "./types";

export interface ChatToolCall { id: string; name: string; args: unknown }

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
}

export interface ChatToolSpec { name: string; description: string; schema: object }
export interface ChatDelta { text?: string; toolCalls?: ChatToolCall[] }

export interface ChatCapableProvider extends ModelProvider {
  chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta>;
  supportsTools(): boolean;
}

export interface ToolProvider {
  name: string;
  description: string;
  schema: object;
  /** Gated tools suspend before execute() until resolveApproval() is called. */
  needsApproval?: boolean;
  /** Human-readable preview of the pending call (diff, command string). Only
   * consulted when needsApproval is true. */
  preview?(args: unknown): Promise<string>;
  execute(args: unknown): Promise<string>;
}

// Re-exported for callers that only need capability shapes, matching how
// types.ts re-exports ModelCapabilities alongside ModelProvider.
export type { ModelCapabilities };
