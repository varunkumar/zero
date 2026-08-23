import { expect, test } from "bun:test";
import {
  parseMessage, ProtocolError, FsSearchParams, FsSearchResult, SettingsSetParams,
  PtyOpenParams, PtyOpenResult, PtyOutputEvent, LspDiagnosticsEvent, LspHoverResult, LspDefinitionResult,
} from "./messages";
import type {
  GraphContextAtParams, GraphQueryResult, PluginListResult, GraphStatusResult,
} from "./messages";

test("round-trips a request", () => {
  const msg = { jsonrpc: "2.0" as const, id: 1, method: "fs/read", params: { path: "a.ts" } };
  expect(parseMessage(JSON.stringify(msg))).toEqual(msg);
});
test("classifies notification (no id)", () => {
  const msg = { jsonrpc: "2.0", method: "fs/changed", params: { path: "a.ts" } };
  const parsed = parseMessage(JSON.stringify(msg));
  expect("id" in parsed).toBe(false);
});
test("rejects garbage", () => {
  expect(() => parseMessage("{}")).toThrow(ProtocolError);
  expect(() => parseMessage("not json")).toThrow(ProtocolError);
});
test("fs/search and settings params/results are plain JSON-serializable shapes", () => {
  const search: FsSearchParams = { query: "foo", caseSensitive: true };
  const result: FsSearchResult = { matches: [{ path: "a.ts", line: 1, column: 0, text: "foo()" }], truncated: false };
  expect(JSON.parse(JSON.stringify(search))).toEqual(search);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);

  const setParams: SettingsSetParams = { key: "workbench", value: { theme: "dark" } };
  expect(JSON.parse(JSON.stringify(setParams))).toEqual(setParams);
});

test("pty message shapes are plain JSON-serializable", () => {
  const open: PtyOpenParams = { cols: 80, rows: 24 };
  const result: PtyOpenResult = { sessionId: "abc", shell: "/bin/bash" };
  const output: PtyOutputEvent = { sessionId: "abc", data: "hello\n" };
  expect(JSON.parse(JSON.stringify(open))).toEqual(open);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(JSON.parse(JSON.stringify(output))).toEqual(output);
});

test("lsp message shapes are plain JSON-serializable", () => {
  const diag: LspDiagnosticsEvent = {
    path: "a.ts",
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "boom" }],
  };
  const hover: LspHoverResult = { contents: "const x: number" };
  const def: LspDefinitionResult = { locations: [{ path: "b.ts", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }] };
  expect(JSON.parse(JSON.stringify(diag))).toEqual(diag);
  expect(JSON.parse(JSON.stringify(hover))).toEqual(hover);
  expect(JSON.parse(JSON.stringify(def))).toEqual(def);
});

test("graph and plugin types are plain JSON-serializable shapes", () => {
  const ctx: GraphContextAtParams = { path: "a.ts", position: { line: 0, character: 1 }, maxChunks: 4 };
  const q: GraphQueryResult = {
    nodes: [{ id: "a", label: "A", source_file: "a.ts", kind: "function" }],
    edges: [{ source: "a", target: "b", relation: "calls" }],
    text: "A calls b",
  };
  const st: GraphStatusResult = {
    ready: true, indexing: false, fileCount: 1, nodeCount: 2, edgeCount: 1, languages: ["typescript"],
  };
  const pl: PluginListResult = {
    plugins: [{
      id: "graphify", name: "Graphify", version: "0.1.0",
      health: { ok: true },
      enabled: true,
      contributions: { rpcMethods: ["graph/query"], contextProviders: ["graph"], tools: ["graph_query"] },
    }],
  };
  expect(JSON.parse(JSON.stringify({ ctx, q, st, pl }))).toEqual({ ctx, q, st, pl });
});

import type {
  ChatMessage, ChatCreateParams, ChatCreateResult, ChatListResult,
  ChatGetResult, ChatAppendParams, ChatRenameParams,
} from "./messages";

test("chat message shapes are plain JSON-serializable", () => {
  const msg: ChatMessage = {
    role: "assistant",
    content: "Reading the file now.",
    toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }],
    createdAt: 1000,
  };
  const toolResult: ChatMessage = {
    role: "tool", content: "export const a = 1;", toolCallId: "call_1", toolName: "fs_read", createdAt: 1001,
  };
  expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  expect(JSON.parse(JSON.stringify(toolResult))).toEqual(toolResult);

  const create: ChatCreateParams = { title: "Refactor plan" };
  const createResult: ChatCreateResult = { id: "abc" };
  const list: ChatListResult = { sessions: [{ id: "abc", title: "Refactor plan", updatedAt: 1000, messageCount: 2 }] };
  const get: ChatGetResult = { id: "abc", title: "Refactor plan", messages: [msg, toolResult] };
  const append: ChatAppendParams = { id: "abc", messages: [msg] };
  const rename: ChatRenameParams = { id: "abc", title: "New title" };
  for (const shape of [create, createResult, list, get, append, rename]) {
    expect(JSON.parse(JSON.stringify(shape))).toEqual(shape);
  }
});

import type {
  ChatTurnEvent, ChatTurnParams, ChatTurnResult, ChatTurnEventPayload,
  ChatApproveParams, ChatAbortParams, ChatStatusResult,
} from "./messages";
import type { SessionHelloResult } from "./messages";

test("session/hello result is a plain JSON-serializable shape", () => {
  const hello: SessionHelloResult = {
    capabilities: {
      pty: true, lsp: true, graph: true, git: true,
      models: ["nano", "openai-compat"],
    },
    workspace: { name: "zero", kind: "daemon" },
  };
  expect(JSON.parse(JSON.stringify(hello))).toEqual(hello);
});

test("chat turn/approval wire shapes are plain JSON-serializable", () => {
  const events: ChatTurnEvent[] = [
    { type: "text", delta: "hi" },
    { type: "toolCall", call: { id: "c1", name: "fs_write", args: { path: "a.ts" } } },
    { type: "toolResult", call: { id: "c1", name: "fs_write", args: {} }, result: "wrote a.ts" },
    { type: "approvalRequest", call: { id: "c1", name: "fs_write", args: {} }, preview: "+hello" },
    { type: "done", message: { role: "assistant", content: "done", createdAt: 1 } },
    { type: "error", message: "boom" },
  ];
  for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event);

  const turnParams: ChatTurnParams = { sessionId: "s1", userText: "hi" };
  const turnResult: ChatTurnResult = { turnId: "t1" };
  const payload: ChatTurnEventPayload = { turnId: "t1", event: events[0]! };
  const approve: ChatApproveParams = { turnId: "t1", callId: "c1", approved: true };
  const abort: ChatAbortParams = { turnId: "t1" };
  const status: ChatStatusResult = { activeModel: "m", reason: null, usedTokens: 42, contextWindowTokens: 100_000 };
  for (const shape of [turnParams, turnResult, payload, approve, abort, status]) {
    expect(JSON.parse(JSON.stringify(shape))).toEqual(shape);
  }
});
