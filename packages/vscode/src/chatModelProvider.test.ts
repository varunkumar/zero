import { expect, test } from "bun:test";
import { createChatModelProvider, type ChatModelProviderOpts } from "./chatModelProvider";
import type { CancellationTokenLike } from "./inlineCompletion";

function fakeToken(): CancellationTokenLike & { cancel(): void } {
  let cancelled = false;
  const handlers: (() => void)[] = [];
  return {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(fn) { handlers.push(fn); return { dispose() {} }; },
    cancel() { cancelled = true; handlers.forEach((h) => h()); },
  };
}

function opts(
  fetchImpl: (url: unknown, init?: RequestInit) => Promise<Response>
): ChatModelProviderOpts {
  return {
    baseUrl: "http://127.0.0.1:1234",
    apiKey: "test-key",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    makeTextPart: (value: string) => ({ kind: "text", value }),
    makeToolCallPart: (callId: string, name: string, input: object) => ({ kind: "toolCall", callId, name, input }),
  };
}

test("provideLanguageModelChatInformation returns [] when the daemon is unreachable", async () => {
  const provider = createChatModelProvider(opts(async () => { throw new Error("connection refused"); }));
  const result = await provider.provideLanguageModelChatInformation({ silent: true }, fakeToken());
  expect(result).toEqual([]);
});

test("provideLanguageModelChatInformation returns [] when no model is available", async () => {
  const provider = createChatModelProvider(opts(async () =>
    new Response(JSON.stringify({ nanoHostConnected: false, provider: null, supportsTools: false }), { status: 200 })
  ));
  const result = await provider.provideLanguageModelChatInformation({ silent: true }, fakeToken());
  expect(result).toEqual([]);
});

test("provideLanguageModelChatInformation advertises toolCalling from /health", async () => {
  const provider = createChatModelProvider(opts(async () =>
    new Response(JSON.stringify({ nanoHostConnected: false, provider: "ollama", supportsTools: true }), { status: 200 })
  ));
  const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, fakeToken());
  expect(info.id).toBe("zero");
  expect(info.capabilities).toEqual({ toolCalling: true });
});

test("provideLanguageModelChatInformation reports toolCalling false when the backend doesn't support it", async () => {
  const provider = createChatModelProvider(opts(async () =>
    new Response(JSON.stringify({ nanoHostConnected: true, provider: "nano-bridge", supportsTools: false }), { status: 200 })
  ));
  const [info] = await provider.provideLanguageModelChatInformation({ silent: true }, fakeToken());
  expect(info.capabilities).toEqual({ toolCalling: false });
});

test("provideLanguageModelChatResponse streams text parts", async () => {
  const sse = [
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join("");
  let capturedRequest: { url: string; body: unknown; headers: Record<string, string> } | undefined;
  const provider = createChatModelProvider(opts(async (url, init) => {
    capturedRequest = {
      url: url as string,
      body: JSON.parse(init!.body as string),
      headers: init!.headers as Record<string, string>,
    };
    return new Response(sse, { status: 200 });
  }));

  const reported: unknown[] = [];
  await provider.provideLanguageModelChatResponse(
    { id: "zero" },
    [{ role: 1, content: [{ value: "hi" }] }],
    { tools: [] },
    { report: (p) => reported.push(p) },
    fakeToken()
  );

  expect(reported).toEqual([{ kind: "text", value: "hel" }, { kind: "text", value: "lo" }]);
  expect(capturedRequest?.url).toBe("http://127.0.0.1:1234/v1/messages");
  expect(capturedRequest?.headers["x-api-key"]).toBe("test-key");
  expect(capturedRequest?.body).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
});

test("provideLanguageModelChatResponse assembles a tool call across delta chunks", async () => {
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"read_file","input":{}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join("");
  const provider = createChatModelProvider(opts(async () => new Response(sse, { status: 200 })));

  const reported: unknown[] = [];
  await provider.provideLanguageModelChatResponse(
    { id: "zero" },
    [{ role: 1, content: [{ value: "read a.ts" }] }],
    { tools: [{ name: "read_file", description: "reads a file", inputSchema: { type: "object" } }] },
    { report: (p) => reported.push(p) },
    fakeToken()
  );

  expect(reported).toEqual([{ kind: "toolCall", callId: "call_1", name: "read_file", input: { path: "a.ts" } }]);
});

test("provideLanguageModelChatResponse translates tool-call and tool-result message parts to Anthropic blocks", async () => {
  let capturedBody: unknown;
  const provider = createChatModelProvider(opts(async (_url, init) => {
    capturedBody = JSON.parse(init!.body as string);
    return new Response(`event: message_stop\ndata: {"type":"message_stop"}\n\n`, { status: 200 });
  }));

  await provider.provideLanguageModelChatResponse(
    { id: "zero" },
    [
      { role: 1, content: [{ value: "read a.ts" }] },
      { role: 2, content: [{ callId: "call_1", name: "read_file", input: { path: "a.ts" } }] },
      { role: 1, content: [{ callId: "call_1", content: [{ value: "file contents" }] }] },
    ],
    { tools: [] },
    { report: () => {} },
    fakeToken()
  );

  expect(capturedBody).toEqual({
    messages: [
      { role: "user", content: [{ type: "text", text: "read a.ts" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }] },
    ],
  });
});

test("provideLanguageModelChatResponse throws on an error event", async () => {
  const sse = `event: error\ndata: {"message":"provider crashed"}\n\n`;
  const provider = createChatModelProvider(opts(async () => new Response(sse, { status: 200 })));

  await expect(
    provider.provideLanguageModelChatResponse(
      { id: "zero" }, [{ role: 1, content: [{ value: "hi" }] }], { tools: [] }, { report: () => {} }, fakeToken()
    )
  ).rejects.toThrow("provider crashed");
});

test("provideLanguageModelChatResponse aborts the fetch when the token cancels", async () => {
  let capturedSignal: AbortSignal | undefined;
  const provider = createChatModelProvider(opts(async (_url, init) => {
    capturedSignal = init!.signal as AbortSignal;
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }));
  const token = fakeToken();
  token.cancel();

  await expect(
    provider.provideLanguageModelChatResponse(
      { id: "zero" }, [{ role: 1, content: [{ value: "hi" }] }], { tools: [] }, { report: () => {} }, token
    )
  ).rejects.toThrow();
  expect(capturedSignal?.aborted).toBe(true);
});

test("provideTokenCount estimates chars/4 for a plain string", async () => {
  const provider = createChatModelProvider(opts(async () => new Response("{}")));
  const count = await provider.provideTokenCount({ id: "zero" }, "twelve chars", fakeToken());
  expect(count).toBe(Math.ceil("twelve chars".length / 4));
});
