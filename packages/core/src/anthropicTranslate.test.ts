import { expect, test } from "bun:test";
import { anthropicRequestToChat, chatDeltaToSseEvents, createSseState } from "./anthropicTranslate";

test("translates an Anthropic Messages request into ChatMessage[] + ChatToolSpec[]", () => {
  const body = {
    system: "You are helpful.",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
    tools: [{ name: "fs_read", description: "Read a file.", input_schema: { type: "object", properties: {} } }],
  };
  const { messages, tools } = anthropicRequestToChat(body);
  expect(messages[0]).toMatchObject({ role: "system", content: "You are helpful." });
  expect(messages[1]).toMatchObject({ role: "user", content: "hi" });
  expect(messages[2]).toMatchObject({ role: "assistant", content: "hello" });
  expect(tools).toEqual([{ name: "fs_read", description: "Read a file.", schema: { type: "object", properties: {} } }]);
});

test("translates a tool_use assistant turn and a following tool_result user turn", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "fs_read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "export const a = 1;" }] },
    ],
  };
  const { messages } = anthropicRequestToChat(body);
  expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }] });
  expect(messages[1]).toMatchObject({ role: "tool", toolCallId: "call_1", content: "export const a = 1;" });
});

test("synthesizes Anthropic SSE events from ChatDeltas", () => {
  const state = createSseState("stub-model");
  const events: string[] = [];
  events.push(...chatDeltaToSseEvents({ text: "hel" }, state));
  events.push(...chatDeltaToSseEvents({ text: "lo" }, state));

  const joined = events.join("");
  expect(joined).toContain("event: message_start");
  expect(joined).toContain("event: content_block_start");
  expect(joined).toContain('"text":"hel"');
  expect(joined).toContain('"text":"lo"');
});
