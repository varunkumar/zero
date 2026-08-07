import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, type SocketLike } from "@zero/protocol";
import { startZero } from "./main";

function wsAdapter(ws: WebSocket): SocketLike {
  const s: SocketLike = { send: (d) => ws.send(d), onmessage: null };
  ws.onmessage = (e) => s.onmessage?.(String(e.data));
  return s;
}

test("fs methods over the wire, watcher broadcasts", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "1");
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  const changed = new Promise<unknown>((r) =>
    client.onNotification((m, p) => { if (m === "fs/changed") r(p); }));

  expect((await client.request<{ entries: { path: string }[] }>("fs/tree")).entries
    .map((e) => e.path)).toContain("a.ts");
  await client.request("fs/write", { path: "a.ts", content: "2" });
  expect((await client.request<{ content: string }>("fs/read", { path: "a.ts" })).content).toBe("2");
  expect(await changed).toEqual({ path: "a.ts" });
  ws.close(); d.stop();
});

test("fs/search and settings RPCs over the wire", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "const target = 1;\n");
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const search = await client.request<{ matches: { path: string }[]; truncated: boolean }>(
    "fs/search", { query: "target" });
  expect(search.matches.map((m) => m.path)).toEqual(["a.ts"]);
  expect(search.truncated).toBe(false);

  expect(await client.request<{ value: unknown }>("settings/get", { key: "workbench" })).toEqual({ value: undefined });
  await client.request("settings/set", { key: "workbench", value: { theme: "dark" } });
  expect(await client.request<{ value: unknown }>("settings/get", { key: "workbench" })).toEqual({ value: { theme: "dark" } });

  ws.close(); d.stop();
});

test("lsp methods over the wire: sync, hover, definition, diagnostics broadcast", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "const greeting: string = \"hi\";\nconsole.log(greeting);\n");
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const diagnosticEvents: unknown[] = [];
  client.onNotification((method, params) => { if (method === "lsp/diagnostics") diagnosticEvents.push(params); });

  await client.request("lsp/sync", { path: "a.ts", content: "const greeting: string = \"hi\";\nconsole.log(greeting);\n" });
  const hover = await client.request<{ contents: string | null }>(
    "lsp/hover", { path: "a.ts", position: { line: 0, character: 6 } });
  expect(hover.contents).toBeTruthy();

  const definition = await client.request<{ locations: { path: string }[] }>(
    "lsp/definition", { path: "a.ts", position: { line: 1, character: 12 } });
  expect(definition.locations.length).toBeGreaterThan(0);

  await client.request("lsp/sync", { path: "a.ts", content: "const greeting: string = 42;\n" });
  await new Promise<void>((resolve) => {
    const check = setInterval(() => { if (diagnosticEvents.length > 0) { clearInterval(check); resolve(); } }, 50);
  });

  ws.close(); d.stop();
}, 20000);

test("pty methods over the wire: open, input/output, resize, close", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const outputs: unknown[] = [];
  client.onNotification((method, params) => { if (method === "pty/output") outputs.push(params); });

  const { sessionId, shell } = await client.request<{ sessionId: string; shell: string }>(
    "pty/open", { shell: "/bin/sh", cols: 80, rows: 24 });
  expect(shell).toBe("/bin/sh");

  const listed = await client.request<{ sessions: { sessionId: string; shell: string }[] }>("pty/list");
  expect(listed.sessions).toEqual([{ sessionId, shell: "/bin/sh" }]);

  await client.request("pty/input", { sessionId, data: "echo pty-wire-test\n" });
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (outputs.some((o) => typeof o === "object" && o !== null && "data" in o
        && String((o as { data: unknown }).data).includes("pty-wire-test"))) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  await client.request("pty/resize", { sessionId, cols: 100, rows: 40 });
  await client.request("pty/close", { sessionId });
  const listedAfter = await client.request<{ sessions: unknown[] }>("pty/list");
  expect(listedAfter.sessions).toEqual([]);

  ws.close(); d.stop();
});

test("plugin/list and graph/status over the wire", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "export function foo() { return 1; }\n");
  const d = await startZero({ root });
  await d.pluginsReady;

  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w);
    w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const list = await client.request<{ plugins: { id: string }[] }>("plugin/list");
  expect(list.plugins.some((p) => p.id === "graphify")).toBe(true);

  const deadline = Date.now() + 30_000;
  let status = await client.request<{ ready: boolean; nodeCount: number }>(
    "graph/status",
  );
  while (!status.ready && Date.now() < deadline) {
    await Bun.sleep(100);
    status = await client.request("graph/status");
  }
  expect(status.nodeCount).toBeGreaterThan(0);

  const ctx = await client.request<{ chunks: unknown[]; ready: boolean }>(
    "graph/contextAt",
    { path: "a.ts", position: { line: 0, character: 0 } },
  );
  expect(ctx.ready).toBe(true);

  ws.close();
  d.stop();
}, 60_000);

test("chat/* RPCs over the wire", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const { id } = await client.request<{ id: string }>("chat/create", { title: "Test chat" });
  expect((await client.request<{ sessions: { id: string; title: string; updatedAt: number; messageCount: number }[] }>("chat/list")).sessions)
    .toEqual([{ id, title: "Test chat", updatedAt: expect.any(Number), messageCount: 0 }]);

  await client.request("chat/append", { id, messages: [{ role: "user", content: "hi", createdAt: 1 }] });
  expect(await client.request<{ id: string; title: string; messages: { role: string; content: string; createdAt: number }[] }>("chat/get", { id })).toEqual({
    id, title: "Test chat", messages: [{ role: "user", content: "hi", createdAt: 1 }],
  });

  await client.request("chat/rename", { id, title: "Renamed" });
  expect((await client.request<{ title: string }>("chat/get", { id })).title).toBe("Renamed");

  await client.request("chat/delete", { id });
  expect((await client.request<{ sessions: unknown[] }>("chat/list")).sessions).toEqual([]);

  ws.close(); d.stop();
});

test("chat/turn streams events and persists the turn (no tools, stub provider unavailable -> error event)", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  const { id } = await client.request<{ id: string }>("chat/create", {});

  const events: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    client.onNotification((method, params) => {
      if (method !== "chat/turnEvent") return;
      const { event } = params as { turnId: string; event: { type: string } };
      events.push(event);
      if (event.type === "error" || event.type === "done") resolve();
    });
  });
  await client.request("chat/turn", { sessionId: id, userText: "hi" });
  await done;

  // No Ollama server is running in the test environment, so ProviderGateway
  // finds nothing available and the turn degrades to an error event -
  // exactly the "never break editing" path M4's AgentRuntime already covers.
  expect(events).toEqual([{ type: "error", message: "no chat model available" }]);
  ws.close(); d.stop();
});

test("a second chat/turn for a session with an already-active turn is rejected, not raced", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  const { id } = await client.request<{ id: string }>("chat/create", {});

  const turnEvents: { turnId: string; event: { type: string } }[] = [];
  client.onNotification((method, params) => {
    if (method === "chat/turnEvent") turnEvents.push(params as { turnId: string; event: { type: string } });
  });

  // Fire two chat/turn RPCs back-to-back, without awaiting the first, so
  // both requests are in flight on the daemon at the same time - this is
  // the exact race window the activeTurns check-and-reserve guard closes:
  // without it, both would pass the "is a turn already running" check
  // before either recorded itself, and both would proceed to call
  // runtimeFor/sendMessage concurrently against the same session.
  const results = await Promise.allSettled([
    client.request<{ turnId: string }>("chat/turn", { sessionId: id, userText: "first" }),
    client.request<{ turnId: string }>("chat/turn", { sessionId: id, userText: "second" }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ turnId: string }>[];
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(String(rejected[0].reason)).toContain("a turn is already in progress for this session");

  // Give the surviving turn's detached IIFE a moment to reach its "no chat
  // model available" error event (no Ollama server is running in tests).
  const deadline = Date.now() + 5000;
  while (!turnEvents.some((e) => e.event.type === "error") && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  // Only the one turn that was actually allowed to start ever produced
  // events - proving the second request never raced a concurrent turn
  // against the same session (which would otherwise show up as either a
  // second distinct turnId's events, or two overlapping streams).
  const turnIds = new Set(turnEvents.map((e) => e.turnId));
  expect(turnIds.size).toBe(1);
  expect([...turnIds][0]).toBe(fulfilled[0].value.turnId);
  expect(turnEvents.map((e) => e.event)).toEqual([{ type: "error", message: "no chat model available" }]);

  ws.close(); d.stop();
});
