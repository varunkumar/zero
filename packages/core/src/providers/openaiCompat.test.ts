import { expect, test } from "bun:test";
import { OpenAICompatProvider } from "./openaiCompat";
import type { ChatToolSpec } from "../chatTypes";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l + "\n\n")); c.close(); },
  });
  return new Response(body, { status: 200 });
}

test("streams SSE chunks", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"text":"hel"}]}',
      'data: {"choices":[{"text":"lo"}]}',
      "data: [DONE]",
    ]),
  });
  let out = "";
  for await (const t of provider.complete("p", new AbortController().signal)) out += t;
  expect(out).toBe("hello");
});

test("available() false when endpoint down", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => { throw new Error("refused"); },
  });
  expect(await provider.available()).toBe(false);
});

test("chat() streams plain text via SSE when no tools are offered", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ]),
  });
  let out = "";
  for await (const delta of provider.chat([{ role: "user", content: "hi", createdAt: 0 }], [], new AbortController().signal)) {
    if (delta.text) out += delta.text;
  }
  expect(out).toBe("hello");
});

test("chat() makes a single non-streaming request and returns tool calls when tools are offered", async () => {
  let capturedBody: { stream?: boolean; tools?: unknown } | undefined;
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "fs_read", arguments: '{"path":"a.ts"}' } }] } }],
      }), { status: 200 });
    },
  });
  const tools: ChatToolSpec[] = [{ name: "fs_read", description: "Read a file.", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "read a.ts", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toEqual([{ text: undefined, toolCalls: [{ id: "c1", name: "fs_read", args: { path: "a.ts" } }] }]);
  expect(capturedBody?.stream).toBe(false);
  expect(capturedBody?.tools).toEqual([{ type: "function", function: { name: "fs_read", description: "Read a file.", parameters: { type: "object" } } }]);
});

test("chat() serializes outbound tool_calls and tool_call_id for assistant/tool-role messages", async () => {
  let capturedBody: { messages?: { role: string; tool_calls?: unknown; tool_call_id?: string }[] } | undefined;
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    },
  });
  const history = [
    { role: "user" as const, content: "read a.ts", createdAt: 0 },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "fs_read", args: { path: "a.ts" } }], createdAt: 1 },
    { role: "tool" as const, content: "export const a = 1;", toolCallId: "c1", toolName: "fs_read", createdAt: 2 },
  ];
  const tools = [{ name: "fs_read", description: "Read a file.", schema: { type: "object" } }];
  for await (const _d of provider.chat(history, tools, new AbortController().signal)) { /* drain */ }

  const assistantMsg = capturedBody?.messages?.find((m) => m.role === "assistant");
  expect(assistantMsg?.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "fs_read", arguments: '{"path":"a.ts"}' } }]);
  const toolMsg = capturedBody?.messages?.find((m) => m.role === "tool");
  expect(toolMsg?.tool_call_id).toBe("c1");
});

test("chat() recovers a tool call embedded as <tool_call> JSON in content when tool_calls is empty", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '<tool_call>\n{"name": "fs_read", "arguments": {"path": "a.ts"}}\n</tool_call>' } }],
    }), { status: 200 }),
  });
  const tools: ChatToolSpec[] = [{ name: "fs_read", description: "Read a file.", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "read a.ts", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas[0]!.text).toBeUndefined();
  expect(deltas[0]!.toolCalls?.[0]?.id).toMatch(/^fallback-0-/);
  expect(deltas[0]!.toolCalls).toEqual([{ id: deltas[0]!.toolCalls![0]!.id, name: "fs_read", args: { path: "a.ts" } }]);
});

test("chat() recovers a tool call that is bare JSON in content with no <tool_call> tags (observed Ollama qwen2.5-coder behavior)", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"name": "fs_tree", "arguments": {}}' } }],
    }), { status: 200 }),
  });
  const tools: ChatToolSpec[] = [{ name: "fs_tree", description: "List files.", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "list files", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas[0]!.text).toBeUndefined();
  expect(deltas[0]!.toolCalls).toEqual([{ id: deltas[0]!.toolCalls![0]!.id, name: "fs_tree", args: {} }]);
});

test("chat() recovers a tool call surrounded by noise: a stray <|im_start|> token and the same call echoed twice, once raw and once in a ```json fence (observed Ollama qwen2.5-coder behavior on fs_edit)", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content:
        '<|im_start|>\n{"name": "fs_edit", "arguments": {"oldText":"hello from zero","newText":"edited by zero","path":"notes.txt"}}\n\n'
        + '```json\n{"name": "fs_edit", "arguments": {"oldText":"hello from zero","newText":"edited by zero","path":"notes.txt"}}\n```' } }],
    }), { status: 200 }),
  });
  const tools: ChatToolSpec[] = [{ name: "fs_edit", description: "Edit a file.", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "edit notes.txt", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas[0]!.text).toBeUndefined();
  expect(deltas[0]!.toolCalls).toHaveLength(1); // the echoed duplicate must be deduped
  expect(deltas[0]!.toolCalls).toEqual([{
    id: deltas[0]!.toolCalls![0]!.id, name: "fs_edit",
    args: { oldText: "hello from zero", newText: "edited by zero", path: "notes.txt" },
  }]);
});

test("chat() leaves ordinary text content alone when it isn't a recognized tool call", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Here is the answer: 42." } }],
    }), { status: 200 }),
  });
  const tools: ChatToolSpec[] = [{ name: "fs_tree", description: "List files.", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "what is the answer", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toEqual([{ text: "Here is the answer: 42.", toolCalls: undefined }]);
});

test("supportsTools() is true", () => {
  const provider = new OpenAICompatProvider({ baseUrl: "http://x/v1", model: "qwen" });
  expect(provider.supportsTools()).toBe(true);
});
