import { parseAnthropicSse, type AnthropicContentBlock } from "./anthropicSse";
import type { CancellationTokenLike } from "./inlineCompletion";

export interface TextPartLike { value: string }
export interface ToolCallPartLike { callId: string; name: string; input: object }
export interface ToolResultPartLike { callId: string; content: ReadonlyArray<TextPartLike | unknown> }
export type MessagePartLike = TextPartLike | ToolCallPartLike | ToolResultPartLike;

/** role follows vscode.LanguageModelChatMessageRole's stable numeric values: User = 1, Assistant = 2. */
export interface ChatMessageLike { role: 1 | 2; content: ReadonlyArray<MessagePartLike> }

export interface LanguageModelChatToolLike { name: string; description: string; inputSchema?: object }

export interface HealthResponseLike { provider: string | null; supportsTools: boolean }

export interface LanguageModelChatInformationLike {
  id: string; name: string; family: string; version: string;
  maxInputTokens: number; maxOutputTokens: number;
  capabilities: { toolCalling: boolean };
}

export interface ChatModelProviderOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Real usage passes vscode's LanguageModelTextPart/LanguageModelToolCallPart
   * constructors; tests pass plain-object factories - progress.report() only
   * needs whatever these produce, never inspects it here. */
  makeTextPart: (value: string) => unknown;
  makeToolCallPart: (callId: string, name: string, input: object) => unknown;
}

export interface ProgressLike { report(part: unknown): void }

export interface ChatModelProvider {
  provideLanguageModelChatInformation(
    options: { silent: boolean }, token: CancellationTokenLike
  ): Promise<LanguageModelChatInformationLike[]>;
  provideLanguageModelChatResponse(
    model: { id: string }, messages: readonly ChatMessageLike[],
    options: { tools?: readonly LanguageModelChatToolLike[] },
    progress: ProgressLike, token: CancellationTokenLike
  ): Promise<void>;
  provideTokenCount(
    model: { id: string }, text: string | ChatMessageLike, token: CancellationTokenLike
  ): Promise<number>;
}

function isToolCallPart(p: unknown): p is ToolCallPartLike {
  return typeof p === "object" && p !== null && "callId" in p && "name" in p && "input" in p;
}
function isToolResultPart(p: unknown): p is ToolResultPartLike {
  return typeof p === "object" && p !== null && "callId" in p && "content" in p;
}

function toolResultText(content: ReadonlyArray<TextPartLike | unknown>): string {
  return content
    .map((c) => (typeof c === "object" && c !== null && "value" in c && typeof (c as TextPartLike).value === "string"
      ? (c as TextPartLike).value
      : JSON.stringify(c)))
    .join("\n");
}

function toAnthropicPart(part: MessagePartLike) {
  if (isToolCallPart(part)) return { type: "tool_use" as const, id: part.callId, name: part.name, input: part.input };
  if (isToolResultPart(part)) return { type: "tool_result" as const, tool_use_id: part.callId, content: toolResultText(part.content) };
  return { type: "text" as const, text: (part as TextPartLike).value };
}

/**
 * Splits a message's parts into runs of consecutive tool-result parts vs. everything
 * else (text/tool_use), preserving order. This mirrors the daemon's blockText() in
 * packages/core/src/anthropicTranslate.ts, which drops any accumulated text once it
 * hits a tool_result and emits a separate "tool" message for the results - if we sent
 * one mixed Anthropic message here, the text half would be silently discarded there.
 * A message with only tool-result parts, or only non-tool-result parts, still yields
 * exactly one message (the common case is unchanged).
 */
function splitMixedContent(content: ReadonlyArray<MessagePartLike>): MessagePartLike[][] {
  const groups: MessagePartLike[][] = [];
  let current: MessagePartLike[] = [];
  let currentIsToolResult: boolean | undefined;
  for (const part of content) {
    const isToolResult = isToolResultPart(part);
    if (current.length > 0 && isToolResult !== currentIsToolResult) {
      groups.push(current);
      current = [];
    }
    current.push(part);
    currentIsToolResult = isToolResult;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function toAnthropicMessages(messages: readonly ChatMessageLike[]) {
  const role = (m: ChatMessageLike) => (m.role === 1 ? ("user" as const) : ("assistant" as const));
  return messages.flatMap((m) =>
    splitMixedContent(m.content).map((group) => ({
      role: role(m),
      content: group.map(toAnthropicPart),
    }))
  );
}

function toAnthropicTools(tools: readonly LanguageModelChatToolLike[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema ?? {} }));
}

function displayName(provider: string): string {
  if (provider === "nano-bridge") return "Zero (Nano)";
  const model = provider.startsWith("openai:") ? provider.slice("openai:".length) : provider;
  return `Zero (${model})`;
}

export function createChatModelProvider(opts: ChatModelProviderOpts): ChatModelProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async provideLanguageModelChatInformation(_options, _token) {
      try {
        const res = await fetchImpl(`${opts.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const health = (await res.json()) as HealthResponseLike;
        if (!health.provider) return [];
        return [{
          id: "zero", name: displayName(health.provider), family: "zero", version: "1",
          maxInputTokens: 8192, maxOutputTokens: 4096,
          capabilities: { toolCalling: health.supportsTools },
        }];
      } catch {
        return [];
      }
    },

    async provideLanguageModelChatResponse(_model, messages, options, progress, token) {
      const controller = new AbortController();
      if (token.isCancellationRequested) controller.abort();
      token.onCancellationRequested(() => controller.abort());

      const body: Record<string, unknown> = { messages: toAnthropicMessages(messages) };
      if (options.tools?.length) body.tools = toAnthropicTools(options.tools);

      const res = await fetchImpl(`${opts.baseUrl}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Zero chat request failed: ${res.status} ${res.statusText}`);
      }

      const pendingToolCalls = new Map<number, { id: string; name: string; json: string }>();
      for await (const event of parseAnthropicSse(res.body)) {
        if (event.event === "content_block_start") {
          const block: AnthropicContentBlock = event.contentBlock;
          if (block.type === "tool_use") {
            pendingToolCalls.set(event.index, { id: block.id, name: block.name, json: "" });
          }
        } else if (event.event === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            progress.report(opts.makeTextPart(event.delta.text));
          } else {
            const call = pendingToolCalls.get(event.index);
            if (call) call.json += event.delta.partialJson;
          }
        } else if (event.event === "content_block_stop") {
          const call = pendingToolCalls.get(event.index);
          if (call) {
            let input: object = {};
            if (call.json) {
              try {
                input = JSON.parse(call.json);
              } catch {
                // Malformed partial_json accumulated for this tool call - report the call
                // with an empty input rather than failing the whole turn over it.
                input = {};
              }
            }
            progress.report(opts.makeToolCallPart(call.id, call.name, input));
            pendingToolCalls.delete(event.index);
          }
        } else if (event.event === "error") {
          throw new Error(event.message);
        }
      }
    },

    async provideTokenCount(_model, text, _token) {
      const content = typeof text === "string"
        ? text
        : text.content.map((p) => ("value" in p ? (p as TextPartLike).value : "")).join("");
      return Math.ceil(content.length / 4);
    },
  };
}
