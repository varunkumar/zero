import type { ChatMessage, ChatToolCall, ChatToolSpec, ChatDelta } from "./chatTypes";

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock { type: "tool_result"; tool_use_id: string; content: string }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
interface AnthropicMessage { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }
interface AnthropicTool { name: string; description: string; input_schema: object }
interface AnthropicRequest { system?: string; messages: AnthropicMessage[]; tools?: AnthropicTool[] }

function blockText(content: string | AnthropicContentBlock[]): { text: string; toolCalls?: ChatToolCall[]; toolResult?: { id: string; content: string } } {
  if (typeof content === "string") return { text: content };
  const toolCalls: ChatToolCall[] = [];
  let text = "";
  let toolResult: { id: string; content: string } | undefined;
  for (const block of content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
    else if (block.type === "tool_result") toolResult = { id: block.tool_use_id, content: block.content };
  }
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, toolResult };
}

export function anthropicRequestToChat(body: unknown): { messages: ChatMessage[]; tools: ChatToolSpec[] } {
  const req = body as AnthropicRequest;
  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system, createdAt: Date.now() });

  for (const m of req.messages) {
    const { text, toolCalls, toolResult } = blockText(m.content);
    if (toolResult) {
      messages.push({ role: "tool", content: toolResult.content, toolCallId: toolResult.id, createdAt: Date.now() });
      continue;
    }
    messages.push({ role: m.role, content: text, toolCalls, createdAt: Date.now() });
  }

  const tools: ChatToolSpec[] = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, schema: t.input_schema }));
  return { messages, tools };
}

export interface SseState { messageStarted: boolean; blockStarted: boolean; model: string; toolCallIndex: number }

export function createSseState(model: string): SseState {
  return { messageStarted: false, blockStarted: false, model, toolCallIndex: 0 };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function chatDeltaToSseEvents(delta: ChatDelta, state: SseState): string[] {
  const out: string[] = [];
  if (!state.messageStarted) {
    state.messageStarted = true;
    out.push(sse("message_start", {
      type: "message_start",
      message: { id: "msg_zero", type: "message", role: "assistant", model: state.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    }));
  }
  if (delta.text) {
    if (!state.blockStarted) {
      state.blockStarted = true;
      out.push(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    }
    out.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.text } }));
  }
  if (delta.toolCalls) {
    for (const call of delta.toolCalls) {
      const index = ++state.toolCallIndex;
      out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }));
      out.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }));
      out.push(sse("content_block_stop", { type: "content_block_stop", index }));
    }
  }
  return out;
}

export function finalSseEvents(state: SseState, stopReason: "end_turn" | "tool_use"): string[] {
  const out: string[] = [];
  if (state.blockStarted) out.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  out.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 0 } }));
  out.push(sse("message_stop", { type: "message_stop" }));
  return out;
}
