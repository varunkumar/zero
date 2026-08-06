import { expect, test } from "bun:test";
import { AgentRuntime, type AgentRuntimeClient, type TurnEvent } from "./agentRuntime";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ToolProvider } from "./chatTypes";

function fakeProvider(opts: {
  id: string; avail?: boolean; supportsTools?: boolean; contextWindowTokens?: number;
  reply: (messages: ChatMessage[], tools: ChatToolSpec[]) => { text?: string; toolCalls?: { id: string; name: string; args: unknown }[] };
}): ChatCapableProvider {
  return {
    id: opts.id,
    available: async () => opts.avail ?? true,
    capabilities: () => ({ id: opts.id, contextWindowTokens: opts.contextWindowTokens ?? 100_000, supportsFim: false }),
    supportsTools: () => opts.supportsTools ?? true,
    async *complete() {},
    async *chat(messages, tools) {
      const r = opts.reply(messages, tools);
      yield { text: r.text, toolCalls: r.toolCalls };
    },
  };
}

function fakeClient(initial: ChatMessage[] = []): AgentRuntimeClient & { saved: ChatMessage[][] } {
  let messages = initial;
  const saved: ChatMessage[][] = [];
  return {
    saved,
    async request<R>(method: string, params?: unknown): Promise<R> {
      if (method === "chat/get") return { messages } as unknown as R;
      if (method === "chat/append") { messages = (params as { messages: ChatMessage[] }).messages; saved.push(messages); return {} as R; }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

async function collect(iter: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

test("happy path with no tool calls: streams text, persists the turn", async () => {
  const provider = fakeProvider({ id: "m", reply: () => ({ text: "hello there" }) });
  const client = fakeClient();
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "hi", new AbortController().signal));
  expect(events).toEqual([
    { type: "text", delta: "hello there" },
    { type: "done", message: { role: "assistant", content: "hello there", toolCalls: undefined, createdAt: expect.any(Number) } },
  ]);
  const persisted = client.saved.at(-1)!;
  expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(runtime.status()).toEqual({ activeModel: "m", reason: null });
});

test("tool-call loop: executes tools, feeds results back, stops when the model replies without tool calls", async () => {
  let round = 0;
  const provider = fakeProvider({
    id: "m",
    reply: (messages) => {
      round++;
      if (round === 1) return { toolCalls: [{ id: "c1", name: "fs_read", args: { path: "a.ts" } }] };
      // second round: the tool result must already be in the transcript
      expect(messages.some((m) => m.role === "tool" && m.content === "export const a = 1;")).toBe(true);
      return { text: "a.ts exports a constant." };
    },
  });
  const tool: ToolProvider = { name: "fs_read", description: "Read a file.", schema: {}, execute: async () => "export const a = 1;" };
  const client = fakeClient();
  const runtime = new AgentRuntime({ providers: [provider], tools: [tool], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "what does a.ts export?", new AbortController().signal));
  expect(events.map((e) => e.type)).toEqual(["toolCall", "toolResult", "text", "done"]);
  expect((events[3] as { type: "done"; message: ChatMessage }).message.content).toBe("a.ts exports a constant.");
});

test("a provider that does not support tools never receives tool specs", async () => {
  let capturedTools: ChatToolSpec[] | undefined;
  const provider = fakeProvider({
    id: "nano", supportsTools: false,
    reply: (_messages, tools) => { capturedTools = tools; return { text: "ok" }; },
  });
  const tool: ToolProvider = { name: "fs_read", description: "Read a file.", schema: {}, execute: async () => "" };
  const runtime = new AgentRuntime({ providers: [provider], tools: [tool], client: fakeClient(), workspace: () => ({}) });

  await collect(runtime.sendMessage("s1", "hi", new AbortController().signal));
  expect(capturedTools).toEqual([]);
});

test("no available provider: yields nothing and sets a degraded status", async () => {
  const provider = fakeProvider({ id: "m", avail: false, reply: () => ({ text: "unreachable" }) });
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client: fakeClient(), workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "hi", new AbortController().signal));
  expect(events).toEqual([]);
  expect(runtime.status()).toEqual({ activeModel: null, reason: "no chat model available" });
});

test("compacts history before the turn once usage exceeds 90% of the context budget", async () => {
  // 6 prior exchanges (12 messages), each long enough to blow a tiny budget.
  const longHistory: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    longHistory.push({ role: "user", content: "q".repeat(400), createdAt: i * 2 });
    longHistory.push({ role: "assistant", content: "a".repeat(400), createdAt: i * 2 + 1 });
  }
  let compactionCall: ChatMessage[] | undefined;
  let turnCall: ChatMessage[] | undefined;
  let calls = 0;
  const provider = fakeProvider({
    id: "m", contextWindowTokens: 500,
    reply: (messages) => {
      calls++;
      if (calls === 1) { compactionCall = messages; return { text: "## Goal\nFinish the thing." }; }
      turnCall = messages;
      return { text: "ok" };
    },
  });
  const client = fakeClient(longHistory);
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client, workspace: () => ({}) });

  await collect(runtime.sendMessage("s1", "status?", new AbortController().signal));
  expect(compactionCall?.some((m) => m.content.includes("Summarize the conversation above."))).toBe(true);
  // Post-compaction turn history: 1 summary message + last 4 kept exchanges (8 messages) + new user message.
  const nonSystemInTurn = turnCall!.filter((m) => m.role !== "system" || m.content.startsWith("## Goal"));
  expect(nonSystemInTurn.some((m) => m.content === "## Goal\nFinish the thing.")).toBe(true);
  expect(turnCall!.filter((m) => m.role === "user" && m.content.startsWith("q")).length).toBe(4);
});

test("cancellation via AbortSignal stops the loop without persisting a partial turn", async () => {
  const ctl = new AbortController();
  const provider: ChatCapableProvider = {
    id: "m",
    available: async () => true,
    capabilities: () => ({ id: "m", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => false,
    async *complete() {},
    async *chat(_messages, _tools, signal) {
      yield { text: "partial" };
      ctl.abort();
      if (signal.aborted) return;
      yield { text: "never" };
    },
  };
  const client = fakeClient();
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "hi", ctl.signal));
  expect(events).toEqual([{ type: "text", delta: "partial" }]);
  expect(client.saved).toEqual([]);
});

test("provider that throws AbortError on cancellation: sendMessage stops cleanly without persisting", async () => {
  const ctl = new AbortController();
  const provider: ChatCapableProvider = {
    id: "m",
    available: async () => true,
    capabilities: () => ({ id: "m", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => false,
    async *complete() {},
    async *chat(_messages, _tools, signal) {
      yield { text: "partial" };
      ctl.abort();
      // Real providers like OpenAICompatProvider throw AbortError when signal fires mid-request
      if (signal.aborted) throw new Error("AbortError");
      yield { text: "never" };
    },
  };
  const client = fakeClient();
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "hi", ctl.signal));
  // Should have yielded the partial text, then the exception is caught and we return cleanly
  expect(events).toEqual([{ type: "text", delta: "partial" }]);
  // No persistence on cancellation
  expect(client.saved).toEqual([]);
});

test("provider that throws a genuine error on chat: sendMessage stops cleanly without throwing", async () => {
  const provider: ChatCapableProvider = {
    id: "m",
    available: async () => true,
    capabilities: () => ({ id: "m", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => false,
    async *complete() {},
    async *chat(_messages, _tools, _signal) {
      yield { text: "partial" };
      throw new Error("network error");
    },
  };
  const client = fakeClient();
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "hi", new AbortController().signal));
  // Should have the partial text, then stops when error is caught
  expect(events).toEqual([{ type: "text", delta: "partial" }]);
  // No persistence on provider error
  expect(client.saved).toEqual([]);
});

test("MAX_TOOL_ROUNDS exhaustion: loop persists history and yields done event with round-limit message", async () => {
  let callCount = 0;
  const provider = fakeProvider({
    id: "m", supportsTools: true,
    reply: () => {
      callCount++;
      // Always return tool calls, never a final response without tools
      return { toolCalls: [{ id: `c${callCount}`, name: "test_tool", args: {} }] };
    },
  });
  const tool: ToolProvider = { name: "test_tool", description: "Test tool.", schema: {}, execute: async () => "ok" };
  const client = fakeClient();
  const runtime = new AgentRuntime({ providers: [provider], tools: [tool], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "hi", new AbortController().signal));

  // Should have MAX_TOOL_ROUNDS worth of tool calls and results, plus a final done event
  const toolCallEvents = events.filter((e) => e.type === "toolCall");
  const toolResultEvents = events.filter((e) => e.type === "toolResult");
  const doneEvents = events.filter((e) => e.type === "done");

  expect(toolCallEvents.length).toBe(8); // MAX_TOOL_ROUNDS = 8
  expect(toolResultEvents.length).toBe(8);
  expect(doneEvents.length).toBe(1);

  const doneMsg = (doneEvents[0] as { type: "done"; message: ChatMessage }).message;
  expect(doneMsg.content).toBe("(tool round limit reached)");
  expect(doneMsg.role).toBe("assistant");

  // History should be persisted
  expect(client.saved.length).toBeGreaterThan(0);
  const persisted = client.saved.at(-1)!;
  // Should have: user msg + 8 rounds of (assistant with tool call + tool result)
  const assistantMsgs = persisted.filter((m) => m.role === "assistant");
  const toolMsgs = persisted.filter((m) => m.role === "tool");
  expect(assistantMsgs.length).toBe(8);
  expect(toolMsgs.length).toBe(8);
});

test("compaction: provider that throws on compaction call returns original history unchanged", async () => {
  const longHistory: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    longHistory.push({ role: "user", content: "q".repeat(400), createdAt: i * 2 });
    longHistory.push({ role: "assistant", content: "a".repeat(400), createdAt: i * 2 + 1 });
  }

  let callCount = 0;
  const provider = fakeProvider({
    id: "m", contextWindowTokens: 500,
    reply: (messages) => {
      callCount++;
      // First call is compaction (has "Summarize the conversation above" message)
      if (messages.some((m) => m.content.includes("Summarize the conversation above."))) {
        throw new Error("compaction provider error");
      }
      // Turn call should proceed normally
      return { text: "ok" };
    },
  });
  const client = fakeClient(longHistory);
  const runtime = new AgentRuntime({ providers: [provider], tools: [], client, workspace: () => ({}) });

  const events = await collect(runtime.sendMessage("s1", "status?", new AbortController().signal));

  // Turn should proceed despite compaction error; should have text and done
  const hasText = events.some((e) => e.type === "text");
  const hasDone = events.some((e) => e.type === "done");
  expect(hasText).toBe(true);
  expect(hasDone).toBe(true);

  // The turn call should have received the original long history (no compaction happened)
  const persisted = client.saved.at(-1)!;
  const userMsgs = persisted.filter((m) => m.role === "user" && m.content.startsWith("q"));
  // Should have all 6 original messages (not compacted down)
  expect(userMsgs.length).toBe(6);
});
