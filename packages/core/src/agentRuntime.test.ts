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
