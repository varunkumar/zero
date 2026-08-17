export interface AnthropicTextBlock { type: "text"; text: string }
export interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export type AnthropicSseEvent =
  | { event: "message_start" }
  | { event: "content_block_start"; index: number; contentBlock: AnthropicContentBlock }
  | { event: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partialJson: string } }
  | { event: "content_block_stop"; index: number }
  | { event: "message_delta"; stopReason: string }
  | { event: "message_stop" }
  | { event: "error"; message: string };

/** Parses the exact SSE shape emitted by packages/core/src/anthropicTranslate.ts
 * (chatDeltaToSseEvents/finalSseEvents) on /v1/messages into typed events. */
export async function* parseAnthropicSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AnthropicSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseEventBlock(rawEvent);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(raw: string): AnthropicSseEvent | null {
  let eventName = "";
  let dataLine = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!eventName || !dataLine) return null;

  let data: any;
  try {
    data = JSON.parse(dataLine);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { event: "error", message: `malformed SSE data line: ${reason}` };
  }
  switch (eventName) {
    case "message_start":
      return { event: "message_start" };
    case "content_block_start":
      return { event: "content_block_start", index: data.index, contentBlock: data.content_block };
    case "content_block_delta": {
      const d = data.delta;
      const delta = d.type === "text_delta"
        ? { type: "text_delta" as const, text: d.text }
        : { type: "input_json_delta" as const, partialJson: d.partial_json };
      return { event: "content_block_delta", index: data.index, delta };
    }
    case "content_block_stop":
      return { event: "content_block_stop", index: data.index };
    case "message_delta":
      return { event: "message_delta", stopReason: data.delta.stop_reason };
    case "message_stop":
      return { event: "message_stop" };
    case "error":
      return { event: "error", message: data.message };
    default:
      return null;
  }
}
