import "../../testUtils/domTestSetup";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatMessage, RpcClient } from "@zero/protocol";
import { ChatPanel, groupForDisplay, shouldShowThinkingIndicator } from "./ChatPanel";
import { ChatStore } from "./store";
import { TurnStore } from "./turnStore";

// jsdom doesn't implement Element.scrollTo (ChatPanel calls it to
// auto-scroll the transcript); a no-op is enough for these tests.
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = () => {};
}

test("shouldShowThinkingIndicator: up the instant a turn is busy, not just once streaming/a tool call starts", () => {
  // The bug this replaces: the indicator used to depend on TurnStore.isActive,
  // which only became true after the first streamed event (e.g. a tool
  // call) - so nothing showed during the gap between sending and that first
  // event. `busy` flips true synchronously when `send()` starts, before the
  // chat/turn RPC even resolves.
  expect(shouldShowThinkingIndicator({ busy: true, streaming: "", pendingApproval: null })).toBe(true);
});

test("shouldShowThinkingIndicator: hides once text is streaming or an approval prompt is up", () => {
  expect(shouldShowThinkingIndicator({ busy: true, streaming: "partial reply", pendingApproval: null })).toBe(false);
  expect(shouldShowThinkingIndicator({ busy: true, streaming: "", pendingApproval: { call: {} } })).toBe(false);
  expect(shouldShowThinkingIndicator({ busy: false, streaming: "", pendingApproval: null })).toBe(false);
});

function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, createdAt: 0, ...extra };
}

test("groupForDisplay collapses a single tool message into a one-item group", () => {
  const groups = groupForDisplay([msg("user", "read a.ts"), msg("tool", "export const a = 1;", { toolName: "fs_read" })]);
  expect(groups).toEqual([
    { kind: "message", message: msg("user", "read a.ts") },
    { kind: "toolGroup", messages: [msg("tool", "export const a = 1;", { toolName: "fs_read" })] },
  ]);
});

test("groupForDisplay collapses a run of consecutive tool messages into one group, without merging across non-tool messages", () => {
  const messages = [
    msg("user", "do two things"),
    msg("tool", "result 1", { toolName: "a" }),
    msg("tool", "result 2", { toolName: "b" }),
    msg("assistant", "done"),
    msg("tool", "result 3", { toolName: "c" }),
  ];
  const groups = groupForDisplay(messages);
  expect(groups.map((g) => g.kind)).toEqual(["message", "toolGroup", "message", "toolGroup"]);
  expect((groups[1] as { kind: "toolGroup"; messages: ChatMessage[] }).messages).toHaveLength(2);
  expect((groups[3] as { kind: "toolGroup"; messages: ChatMessage[] }).messages).toHaveLength(1);
});

type Handler = (params?: unknown) => Promise<unknown>;

function makeClient(overrides: Record<string, Handler> = {}): RpcClient {
  const handlers: Record<string, Handler> = {
    "system/whoami": async () => ({ username: "tester" }),
    "chat/list": async () => ({ sessions: [{ id: "s1", title: "Chat", updatedAt: Date.now(), messageCount: 0 }] }),
    "models/list": async () => ({ url: "", models: [], running: [], active: null }),
    "chat/get": async () => ({ messages: [] }),
    "chat/status": async () => ({ activeModel: null, reason: null }),
    ...overrides,
  };
  return {
    request: (method: string, params?: unknown) => {
      const handler = handlers[method];
      if (!handler) return Promise.reject(new Error(`unexpected method in test: ${method}`));
      return handler(params);
    },
    onNotification: () => () => {},
  } as unknown as RpcClient;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

test("a loaded session's tool calls render collapsed by default, expandable on click", async () => {
  const chatStore = new ChatStore();
  chatStore.setSessions([{ id: "s1", title: "Chat", updatedAt: Date.now(), messageCount: 0 }]);
  const client = makeClient({
    "chat/get": async () => ({
      messages: [
        msg("user", "what does a.ts export?"),
        msg("tool", "export const a = 1;", { toolName: "fs_read" }),
        msg("assistant", "a.ts exports a constant."),
      ],
    }),
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChatPanel client={client} turnStore={new TurnStore()} chatStore={chatStore} />);
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(container.textContent).toContain("1 tool call");
  expect(container.textContent).not.toContain("export const a = 1;");

  const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("tool call"))!;
  await act(async () => { toggle.click(); });
  expect(container.textContent).toContain("export const a = 1;");
});
