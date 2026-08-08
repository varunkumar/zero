import { expect, test } from "bun:test";
import { anthropicRequestToChat, chatDeltaToSseEvents, createSseState, finalSseEvents } from "./anthropicTranslate";

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

test("synthesizes Anthropic SSE events from ChatDeltas with multiple text deltas", () => {
  const state = createSseState("stub-model");
  const events: string[] = [];
  events.push(...chatDeltaToSseEvents({ text: "hel" }, state));
  events.push(...chatDeltaToSseEvents({ text: "lo" }, state));

  const joined = events.join("");
  expect(joined).toContain("event: message_start");
  expect(joined).toContain("event: content_block_start");
  expect(joined).toContain('"text":"hel"');
  expect(joined).toContain('"text":"lo"');
  // Assert content_block_start appears exactly once, not multiple times
  const contentBlockStartMatches = joined.match(/event: content_block_start/g);
  expect(contentBlockStartMatches?.length).toBe(1);
});

test("translates multiple tool_result blocks in a single user turn", () => {
  const body = {
    messages: [
      { role: "assistant", content: [
        { type: "tool_use", id: "call_1", name: "fs_read", input: { path: "a.ts" } },
        { type: "tool_use", id: "call_2", name: "fs_read", input: { path: "b.ts" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_1", content: "export const a = 1;" },
        { type: "tool_result", tool_use_id: "call_2", content: "export const b = 2;" },
      ] },
    ],
  };
  const { messages } = anthropicRequestToChat(body);
  expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [
    { id: "call_1", name: "fs_read", args: { path: "a.ts" } },
    { id: "call_2", name: "fs_read", args: { path: "b.ts" } },
  ] });
  expect(messages[1]).toMatchObject({ role: "tool", toolCallId: "call_1", content: "export const a = 1;" });
  expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "call_2", content: "export const b = 2;" });
  expect(messages.length).toBe(3);
});

test("tool-call-only delta uses index 0 instead of 1", () => {
  const state = createSseState("stub-model");
  const events: string[] = [];
  events.push(...chatDeltaToSseEvents({ toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }] }, state));

  const joined = events.join("");
  expect(joined).toContain("event: message_start");
  // The tool block should start at index 0, not index 1
  expect(joined).toContain('"index":0');
  expect(joined).toContain('"type":"tool_use"');
});

test("finalSseEvents with text blocks and tool-call-only turns", () => {
  // Case 1: After text deltas
  const state1 = createSseState("stub-model");
  chatDeltaToSseEvents({ text: "hello" }, state1);
  const finalEvents1 = finalSseEvents(state1, "end_turn");
  const joined1 = finalEvents1.join("");

  expect(joined1).toContain("event: content_block_stop");
  expect(joined1).toContain('"index":0'); // Should close the text block at index 0
  expect(joined1).toContain("event: message_delta");
  expect(joined1).toContain('"stop_reason":"end_turn"');
  expect(joined1).toContain("event: message_stop");

  // Case 2: Tool-call-only turn (no preceding text)
  const state2 = createSseState("stub-model");
  const deltaEvents2 = chatDeltaToSseEvents({ toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }] }, state2);
  const finalEvents2 = finalSseEvents(state2, "tool_use");
  const joined2Final = finalEvents2.join("");

  // finalSseEvents should NOT emit content_block_stop for text when text was never started
  expect(joined2Final).not.toContain("event: content_block_stop");
  expect(joined2Final).toContain("event: message_delta");
  expect(joined2Final).toContain('"stop_reason":"tool_use"');
  expect(joined2Final).toContain("event: message_stop");

  // Combined events should have the full flow
  const allEvents2 = [...deltaEvents2, ...finalEvents2].join("");
  expect(allEvents2).toContain("event: message_start");
  expect(allEvents2).toContain("event: content_block_start");
  expect(allEvents2).toContain("event: content_block_stop");
});
