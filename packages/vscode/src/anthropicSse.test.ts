import { expect, test } from "bun:test";
import { parseAnthropicSse } from "./anthropicSse";

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseAnthropicSse(stream)) events.push(event);
  return events;
}

test("parses a text-only message into text_delta events", async () => {
  const raw = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_zero"}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join("");

  const events = await collect(sseBody(raw));

  expect(events).toEqual([
    { event: "message_start" },
    { event: "content_block_start", index: 0, contentBlock: { type: "text", text: "" } },
    { event: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { event: "content_block_stop", index: 0 },
    { event: "message_delta", stopReason: "end_turn" },
    { event: "message_stop" },
  ]);
});

test("parses a tool_use block's start/delta/stop", async () => {
  const raw = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"read_file","input":{}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
  ].join("");

  const events = await collect(sseBody(raw));

  expect(events).toEqual([
    { event: "content_block_start", index: 1, contentBlock: { type: "tool_use", id: "call_1", name: "read_file", input: {} } },
    { event: "content_block_delta", index: 1, delta: { type: "input_json_delta", partialJson: '{"path":"a.ts"}' } },
    { event: "content_block_stop", index: 1 },
  ]);
});

test("parses an error event", async () => {
  const raw = `event: error\ndata: {"message":"provider crashed"}\n\n`;
  const events = await collect(sseBody(raw));
  expect(events).toEqual([{ event: "error", message: "provider crashed" }]);
});

test("reassembles an event split across multiple stream chunks", async () => {
  const full = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n`;
  const splitAt = 30;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(full);
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    },
  });

  const events = await collect(stream);

  expect(events).toEqual([
    { event: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
  ]);
});
