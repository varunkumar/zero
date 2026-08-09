import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, type SocketLike } from "@zero/protocol";
import { startZero } from "./main";
import { useTempZeroHome } from "./testSupport/zeroHome";

useTempZeroHome();

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

test("gateway-key is written to a fresh workspace with no prior .zero/ directory, mode 0600", async () => {
  // A genuinely fresh workspace has no .zero/ directory yet - it's created
  // lazily elsewhere (SessionStore.create/writeSetting), so starting with
  // --gateway-port and no prior session must not silently ENOENT.
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });

  const keyPath = join(root, ".zero", "gateway-key");
  const content = await readFile(keyPath, "utf8");
  expect(content).toBe(d.gatewayInfo!.apiKey);

  if (process.platform !== "win32") {
    const st = await stat(keyPath);
    expect(st.mode & 0o777).toBe(0o600);
  }

  d.stop();
});

test("chat/status doesn't construct a runtime for a never-turned session, and reflects the pool after chat/delete evicts it", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  const { id } = await client.request<{ id: string }>("chat/create", {});

  // A session that has never had chat/turn called for it should report the
  // neutral "no chat model" status without erroring or requiring a real
  // provider - status checks must not be a side-effecting construction
  // trigger (the web ChatPanel calls chat/status on every session switch).
  const status = await client.request<{ activeModel: string | null; reason: string | null }>(
    "chat/status", { sessionId: id },
  );
  expect(status).toEqual({ activeModel: null, reason: null });

  // Start (and let finish) a turn so the pool actually has an entry for this
  // session, then delete the session and confirm chat/status still degrades
  // cleanly (deletion evicts the pool entry rather than leaking it forever).
  const done = new Promise<void>((resolve) => {
    client.onNotification((method, params) => {
      if (method !== "chat/turnEvent") return;
      const { event } = params as { event: { type: string } };
      if (event.type === "error" || event.type === "done") resolve();
    });
  });
  await client.request("chat/turn", { sessionId: id, userText: "hi" });
  await done;

  // Now that a turn has actually run, the pool has a real cached runtime
  // for this session, and chat/status reflects its (non-neutral) status -
  // distinguishing this from the "never constructed" neutral default above.
  const statusAfterTurn = await client.request<{ activeModel: string | null; reason: string | null }>(
    "chat/status", { sessionId: id },
  );
  expect(statusAfterTurn.reason).toBe("no chat model available");

  await client.request("chat/delete", { id });
  const statusAfterDelete = await client.request<{ activeModel: string | null; reason: string | null }>(
    "chat/status", { sessionId: id },
  );
  expect(statusAfterDelete).toEqual({ activeModel: null, reason: null });

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

test("chat/abort still produces a terminal chat/turnEvent broadcast, not silence", async () => {
  // AgentRuntime.sendMessage has early-return points on an aborted signal
  // that end the generator without yielding a final done/error event. The
  // daemon must still broadcast a synthetic terminal event so every
  // consumer of chat/turnEvent sees a definitive close signal rather than
  // the stream just stopping.
  //
  // To actually exercise that early-return path (rather than the unrelated
  // "no chat model available" path that fires unconditionally when no
  // provider is reachable), stand up a fake OpenAI-compatible server that
  // reports itself available but hangs forever on the actual chat
  // completion request. The only way this turn can ever end is via abort.
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        return new Promise<Response>(() => {}); // never resolves
      }
      return new Response("not found", { status: 404 });
    },
  });

  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  try {
    await client.request("settings/set", { key: "zero.ollamaUrl", value: `http://127.0.0.1:${fake.port}/v1` });
    const { id } = await client.request<{ id: string }>("chat/create", {});

    const events: { type: string; message?: string }[] = [];
    const done = new Promise<void>((resolve) => {
      client.onNotification((method, params) => {
        if (method !== "chat/turnEvent") return;
        const { event } = params as { event: { type: string; message?: string } };
        events.push(event);
        resolve();
      });
    });

    const { turnId } = await client.request<{ turnId: string }>("chat/turn", { sessionId: id, userText: "hi" });
    // Give the turn a brief moment to actually reach the hanging fetch
    // before aborting, so this exercises a mid-flight abort (not just an
    // already-aborted signal at the very top of sendMessage).
    await Bun.sleep(50);
    await client.request("chat/abort", { turnId });
    await done;

    expect(events).toEqual([{ type: "error", message: "aborted" }]);
  } finally {
    fake.stop(true);
    ws.close();
    d.stop();
  }
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

  const turnEvents: { turnId: string; event: { type: string; message?: string } }[] = [];
  client.onNotification((method, params) => {
    if (method === "chat/turnEvent") turnEvents.push(params as { turnId: string; event: { type: string; message?: string } });
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
