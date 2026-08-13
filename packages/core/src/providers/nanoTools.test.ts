import { expect, test } from "bun:test";
import { buildToolResponseConstraint, parseNanoToolResponse } from "./nanoTools";
import type { ChatToolSpec } from "../chatTypes";

const tools: ChatToolSpec[] = [
  { name: "fs_read", description: "read a file", schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "fs_write", description: "write a file", schema: { type: "object" } },
];

test("buildToolResponseConstraint names every offered tool", () => {
  const schema = buildToolResponseConstraint(tools) as { properties: { tool: { enum: string[] } } };
  expect(schema.properties.tool.enum).toEqual(["fs_read", "fs_write"]);
});

test("parseNanoToolResponse parses a tool_call into a ChatDelta with toolCalls", () => {
  const delta = parseNanoToolResponse(JSON.stringify({ kind: "tool_call", tool: "fs_read", input: { path: "a.ts" } }), tools);
  expect(delta.toolCalls).toHaveLength(1);
  expect(delta.toolCalls![0]!.name).toBe("fs_read");
  expect(delta.toolCalls![0]!.args).toEqual({ path: "a.ts" });
  expect(typeof delta.toolCalls![0]!.id).toBe("string");
});

test("parseNanoToolResponse parses a plain answer into text", () => {
  const delta = parseNanoToolResponse(JSON.stringify({ kind: "answer", text: "hello" }), tools);
  expect(delta).toEqual({ text: "hello" });
});

test("parseNanoToolResponse rejects a tool name outside the offered set, falling back to raw text", () => {
  const raw = JSON.stringify({ kind: "tool_call", tool: "rm_rf", input: {} });
  expect(parseNanoToolResponse(raw, tools)).toEqual({ text: raw });
});

test("parseNanoToolResponse falls back to raw text when the model ignores the constraint", () => {
  expect(parseNanoToolResponse("not json at all", tools)).toEqual({ text: "not json at all" });
});
