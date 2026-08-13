import { expect, test } from "bun:test";
import type { ChatCapableProvider } from "@zero/core";
import { createMemRoot } from "./memDir";
import { BrowserFSWorkspace } from "./browserFs";
import { createMemorySessionDb, LiteSessionStore } from "./sessionStore";
import { LiteChatHost } from "./chatHost";

function stubProvider(text: string): ChatCapableProvider {
  return {
    id: "stub",
    available: async () => true,
    capabilities: () => ({ id: "stub", contextWindowTokens: 1000, supportsFim: false }),
    supportsTools: () => false,
    complete: async function* () {},
    chat: async function* () { yield { text }; },
  };
}

async function makeHost(opts: { providers: ChatCapableProvider[]; notify: (m: string, p: unknown) => void }) {
  const root = createMemRoot("proj");
  const fs = new BrowserFSWorkspace(root);
  const store = new LiteSessionStore("root-1", createMemorySessionDb());
  return new LiteChatHost({
    store, fs, folderName: "proj", providers: opts.providers, notify: opts.notify,
  });
}

test("chat/turn streams text and persists", async () => {
  const events: unknown[] = [];
  const host = await makeHost({
    providers: [stubProvider("hi")],
    notify: (m, p) => {
      if (m === "chat/turnEvent") events.push((p as { event: unknown }).event);
    },
  });
  const { id } = (await host.handle("chat/create", {})) as { id: string };
  const { turnId } = (await host.handle("chat/turn", { sessionId: id, userText: "yo" })) as { turnId: string };
  await Bun.sleep(20);
  expect(turnId).toBeTruthy();
  expect(events.some((e) => (e as { type: string }).type === "text")).toBe(true);
  const got = (await host.handle("chat/get", { id })) as { messages: { role: string }[] };
  expect(got.messages.some((m) => m.role === "user")).toBe(true);
});

test("second in-flight turn is rejected", async () => {
  const host = await makeHost({
    providers: [{
      ...stubProvider("x"),
      chat: async function* (_m, _t, signal) {
        yield { text: "x" };
        await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      },
    }],
    notify: () => {},
  });
  const { id } = (await host.handle("chat/create", {})) as { id: string };
  await host.handle("chat/turn", { sessionId: id, userText: "one" });
  await expect(host.handle("chat/turn", { sessionId: id, userText: "two" }))
    .rejects.toThrow("a turn is already in progress for this session");
});

test("chat/status reports no model before any turn runs", async () => {
  const host = await makeHost({ providers: [stubProvider("hi")], notify: () => {} });
  const { id } = (await host.handle("chat/create", {})) as { id: string };
  expect(await host.handle("chat/status", { sessionId: id })).toEqual({
    activeModel: null, reason: null, usedTokens: null, contextWindowTokens: null,
  });
});

test("chat/list and chat/rename and chat/delete round-trip", async () => {
  const host = await makeHost({ providers: [stubProvider("hi")], notify: () => {} });
  const { id } = (await host.handle("chat/create", { title: "first" })) as { id: string };
  expect(((await host.handle("chat/list", {})) as { sessions: { id: string; title: string; updatedAt: number; messageCount: number }[] }).sessions)
    .toEqual([{ id, title: "first", updatedAt: expect.any(Number), messageCount: 0 }]);
  await host.handle("chat/rename", { id, title: "renamed" });
  expect(((await host.handle("chat/get", { id })) as { title: string }).title).toBe("renamed");
  await host.handle("chat/delete", { id });
  await expect(host.handle("chat/get", { id })).rejects.toThrow();
});

test("dispose aborts every in-flight turn and evicts the runtime pool", async () => {
  let aborted = false;
  const host = await makeHost({
    providers: [{
      ...stubProvider("x"),
      chat: (async function* (_m, _t, signal) {
        yield { text: "x" };
        await new Promise<void>((r) => signal.addEventListener("abort", () => { aborted = true; r(); }, { once: true }));
      }) as ChatCapableProvider["chat"],
    }],
    notify: () => {},
  });
  const { id } = (await host.handle("chat/create", {})) as { id: string };
  await host.handle("chat/turn", { sessionId: id, userText: "one" });
  await Bun.sleep(10);

  host.dispose();
  await Bun.sleep(10);

  expect(aborted).toBe(true);
  // evictAll() dropped the pooled runtime, so chat/status reports "no
  // model" again exactly as it would before any turn ever ran.
  expect(await host.handle("chat/status", { sessionId: id })).toEqual({
    activeModel: null, reason: null, usedTokens: null, contextWindowTokens: null,
  });
});

test("fs_write executed by the agent notifies fs/changed", async () => {
  const notifications: { method: string; params: unknown }[] = [];
  const hostRef: { current?: Awaited<ReturnType<typeof makeHost>> } = {};
  const host = await makeHost({
    providers: [{
      ...stubProvider(""),
      supportsTools: () => true,
      chat: (async function* () {
        yield { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "a.txt", content: "hi" } }] };
      }) as ChatCapableProvider["chat"],
    }],
    notify: (m, p) => {
      notifications.push({ method: m, params: p });
      if (m === "chat/turnEvent") {
        const { turnId, event } = p as { turnId: string; event: { type: string } };
        if (event.type === "approvalRequest") {
          void hostRef.current!.handle("chat/approve", { turnId, callId: "c1", approved: true });
        }
      }
    },
  });
  hostRef.current = host;
  const { id } = (await host.handle("chat/create", {})) as { id: string };
  await host.handle("chat/turn", { sessionId: id, userText: "write a file" });
  await Bun.sleep(20);
  expect(notifications.some((n) => n.method === "fs/changed" && (n.params as { path: string }).path === "a.txt"))
    .toBe(true);
});
