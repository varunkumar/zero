# M7: Zero Claude Plugin (Nano Bridge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code run entirely offline against Gemini Nano, by
bridging the daemon's existing Anthropic-compatible `/v1/messages` gateway
to a `ChromeNanoProvider` running inside an already-open Zero browser tab.

**Architecture:** A new reverse-RPC primitive lets the daemon call into one
specific connected browser client and await a streamed reply. A
`NanoHostRegistry` tracks which tab (the foreground one) answers those
calls, backing a `NanoBridgeProvider` wired only into the model gateway's
`ProviderGateway`. Nano's lack of native tool-calling is emulated with
constrained JSON decoding (`responseConstraint`), translated to/from
`tool_use` blocks by the gateway's existing (unchanged) SSE synthesis. A
`zero claude` CLI starts the daemon+gateway and reports Nano attachment
status.

**Tech Stack:** Bun, TypeScript strict/ESM, Zod, Chrome's `LanguageModel`
Prompt API (`responseConstraint` JSON-schema constrained decoding).

**Spec:** `docs/superpowers/specs/2026-08-13-m7-zero-claude-plugin-design.md`

## Global Constraints

- All packages: TypeScript `strict: true`, ESM only.
- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs.
- Daemon binds `127.0.0.1` only.
- `ChromeNanoProvider.supportsTools()` stays `false` — do not flip it.
  `chat()` honors a non-empty `tools` argument regardless of that flag;
  only `NanoBridgeProvider` (daemon-side, gateway-only) reports
  `supportsTools() === true`.
- `NanoBridgeProvider` is added only to the `ProviderGateway` built for
  `startModelGateway` in `packages/daemon/src/main.ts` — never to the
  `chat/turn`/`AgentRuntime` provider list.
- Commit after every task; conventional-commit style messages.
- Run `bun test` and `bun run typecheck` before every commit that touches
  more than a comment.

---

### Task 1: `RpcClient` — answer incoming requests, send notifications

**Files:**
- Modify: `packages/protocol/src/client.ts`
- Test: `packages/protocol/src/client.test.ts`

**Interfaces:**
- Consumes: `parseMessage` (existing).
- Produces: `RpcClient.onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void`;
  `RpcClient.notify(method: string, params?: unknown): void`. Both are new
  public methods on the existing `RpcClient` class; its constructor
  signature (`new RpcClient(socket: SocketLike)`) is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/client.test.ts`:

```ts
test("answers a registered incoming request and sends a response", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  client.onRequest("nano/chat", async (params) => ({ echo: params }));
  sock.receive({ jsonrpc: "2.0", id: 7, method: "nano/chat", params: { a: 1 } });
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ jsonrpc: "2.0", id: 7, result: { echo: { a: 1 } } });
});

test("responds with an error for an unregistered incoming method", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  sock.receive({ jsonrpc: "2.0", id: 8, method: "nope" });
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
    jsonrpc: "2.0", id: 8, error: { code: -32601, message: "unknown method nope" },
  });
});

test("responds with an error when a request handler throws", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  client.onRequest("boom", async () => { throw new Error("kaboom"); });
  sock.receive({ jsonrpc: "2.0", id: 9, method: "boom" });
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
    jsonrpc: "2.0", id: 9, error: { code: -32000, message: "kaboom" },
  });
});

test("sends a fire-and-forget notification with no id", () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  client.notify("nano/chatDelta", { requestId: "r1", delta: { text: "hi" } });
  expect(JSON.parse(sock.sent[0]!)).toEqual({
    jsonrpc: "2.0", method: "nano/chatDelta", params: { requestId: "r1", delta: { text: "hi" } },
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/protocol/src/client.test.ts`
Expected: FAIL — `client.onRequest is not a function` / `client.notify is not a function`.

- [ ] **Step 3: Implement**

Replace the contents of `packages/protocol/src/client.ts`:

```ts
import { parseMessage } from "./messages";

export interface SocketLike {
  send(data: string): void;
  onmessage: ((data: string) => void) | null;
}

export class RpcClient {
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #notify: ((method: string, params: unknown) => void) | null = null;
  #requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private socket: SocketLike) {
    socket.onmessage = (raw) => {
      const msg = parseMessage(raw);
      if ("id" in msg && ("result" in msg || "error" in msg)) {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } else if ("id" in msg && "method" in msg) {
        void this.#handleIncomingRequest(msg.id, msg.method, msg.params);
      } else if (!("id" in msg)) {
        this.#notify?.(msg.method, msg.params);
      }
    };
  }

  request<R>(method: string, params?: unknown): Promise<R> {
    const id = this.#next++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<R>((resolve, reject) =>
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /** Fire-and-forget: sends `{method, params}` with no `id`. */
  notify(method: string, params?: unknown) {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(handler: (method: string, params: unknown) => void) { this.#notify = handler; }

  /** Registers a handler for requests the *other end* sends to us (reverse-RPC:
   * the daemon calling into this client). Unregistered methods get an
   * unknown-method error response, matching RpcServer's behavior. */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>) {
    this.#requestHandlers.set(method, handler);
  }

  async #handleIncomingRequest(id: number, method: string, params: unknown) {
    const handler = this.#requestHandlers.get(method);
    if (!handler) {
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } }));
      return;
    }
    try {
      const result = await handler(params);
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (e) {
      this.socket.send(JSON.stringify({
        jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/protocol`
Expected: all PASS (existing 3 tests plus the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/client.ts packages/protocol/src/client.test.ts
git commit -m "feat(protocol): RpcClient answers incoming requests and sends notifications"
```

---

### Task 2: `RpcServer` — client notifications and a `ctx` parameter

**Files:**
- Modify: `packages/daemon/src/rpc.ts`
- Create: `packages/daemon/src/rpc.test.ts`

**Interfaces:**
- Consumes: `parseMessage`, `ProtocolError` (`@zero/protocol`, existing).
- Produces: `RpcServer.registerNotification(method: string, fn: (params: unknown) => void): void`;
  `RpcServer.dispatch(raw: string, ctx?: { ws: unknown }): Promise<string | null>`
  (gains the optional second parameter); `register<P, R>(method, schema, fn: (params: P, ctx?: { ws: unknown }) => Promise<R>)`
  (handler type gains an optional second parameter — existing single-parameter
  handlers remain valid TS).

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/rpc.test.ts`:

```ts
import { expect, test } from "bun:test";
import { z } from "zod";
import { RpcServer } from "./rpc";

test("dispatches a registered method", async () => {
  const rpc = new RpcServer();
  rpc.register("echo", z.object({ v: z.string() }), async (p) => ({ v: p.v }));
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { v: "x" } }));
  expect(JSON.parse(reply!)).toEqual({ jsonrpc: "2.0", id: 1, result: { v: "x" } });
});

test("unknown method and bad params return errors", async () => {
  const rpc = new RpcServer();
  rpc.register("echo", z.object({ v: z.string() }), async (p) => p);
  const r1 = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }));
  const r2 = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo", params: { v: 7 } }));
  expect(JSON.parse(r1!).error.code).toBe(-32601);
  expect(JSON.parse(r2!).error.code).toBe(-32602);
});

test("passes ctx through to the handler when provided", async () => {
  const rpc = new RpcServer();
  const seen: unknown[] = [];
  rpc.register("withCtx", z.object({}).optional().transform(() => ({})),
    async (_p, ctx) => { seen.push(ctx); return {}; });
  const ctx = { ws: "fake-socket" };
  await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "withCtx" }), ctx);
  expect(seen).toEqual([ctx]);
});

test("handlers that ignore ctx still work", async () => {
  const rpc = new RpcServer();
  rpc.register("noCtx", z.object({}).optional().transform(() => ({})), async () => ({ ok: true }));
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "noCtx" }), { ws: {} });
  expect(JSON.parse(reply!)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
});

test("routes a notification (no id) to a registered notification handler", async () => {
  const rpc = new RpcServer();
  const seen: unknown[] = [];
  rpc.registerNotification("ping", (params) => seen.push(params));
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: { n: 1 } }));
  expect(reply).toBeNull();
  expect(seen).toEqual([{ n: 1 }]);
});

test("a notification with no registered handler is silently dropped", async () => {
  const rpc = new RpcServer();
  const reply = await rpc.dispatch(JSON.stringify({ jsonrpc: "2.0", method: "unheard", params: {} }));
  expect(reply).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/rpc.test.ts`
Expected: FAIL — `rpc.registerNotification is not a function`, ctx tests get `undefined` instead of the expected object.

- [ ] **Step 3: Implement**

Replace the contents of `packages/daemon/src/rpc.ts`:

```ts
import { z } from "zod";
import { parseMessage, ProtocolError } from "@zero/protocol";

export interface RpcCtx { ws: unknown }
type Handler = { schema: z.ZodType<unknown>; fn: (params: unknown, ctx?: RpcCtx) => Promise<unknown> };

export class RpcServer {
  #methods = new Map<string, Handler>();
  #notifications = new Map<string, (params: unknown) => void>();

  register<P, R>(method: string, schema: z.ZodType<P>, fn: (params: P, ctx?: RpcCtx) => Promise<R>) {
    this.#methods.set(method, { schema, fn: fn as Handler["fn"] });
  }

  /** Registers a handler for client-sent notifications (messages with a
   * `method` but no `id` — no response is ever sent back for these). */
  registerNotification(method: string, fn: (params: unknown) => void) {
    this.#notifications.set(method, fn);
  }

  async dispatch(raw: string, ctx?: RpcCtx): Promise<string | null> {
    let id: number | null = null;
    try {
      const msg = parseMessage(raw);
      if (!("method" in msg)) return null;
      if (!("id" in msg)) {
        this.#notifications.get(msg.method)?.(msg.params);
        return null;
      }
      id = msg.id;
      const handler = this.#methods.get(msg.method);
      if (!handler) return respondError(id, -32601, `unknown method ${msg.method}`);
      const params = handler.schema.safeParse(msg.params);
      if (!params.success) return respondError(id, -32602, "invalid params");
      const result = await handler.fn(params.data, ctx);
      return JSON.stringify({ jsonrpc: "2.0", id, result });
    } catch (e) {
      if (e instanceof ProtocolError) return respondError(id ?? 0, -32700, e.message);
      return respondError(id ?? 0, -32000, e instanceof Error ? e.message : "internal error");
    }
  }
}

function respondError(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/rpc.test.ts packages/daemon/src/server.test.ts`
Expected: all PASS (`server.test.ts` is unaffected since `rpc.dispatch(raw)` — one argument — still type-checks against the new optional-`ctx` signature).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/rpc.ts packages/daemon/src/rpc.test.ts
git commit -m "feat(daemon): RpcServer notification routing and handler ctx"
```

---

### Task 3: `server.ts` — reverse requests to one socket, close hooks

**Files:**
- Modify: `packages/daemon/src/server.ts`
- Test: `packages/daemon/src/server.test.ts`

**Interfaces:**
- Consumes: `RpcServer` (Task 2, `RpcCtx`), `parseMessage` (`@zero/protocol`).
- Produces: on the object returned by `createDaemon`, two new members:
  `requestSocket<R>(ws: Bun.ServerWebSocket<unknown>, method: string, params?: unknown): Promise<R>`
  and `onSocketClose(fn: (ws: Bun.ServerWebSocket<unknown>) => void): void`, plus
  the existing internal `sockets: Set<Bun.ServerWebSocket<unknown>>` is now
  exposed on the returned object (read-only use: iterate to find a specific
  socket, e.g. in tests or `NanoHostRegistry` wiring).

- [ ] **Step 1: Write the failing tests**

Append to `packages/daemon/src/server.test.ts`:

```ts
test("requestSocket sends a request to one socket and resolves from its response", async () => {
  const d = createDaemon({ root: "/tmp" });
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;

  const received = new Promise<{ id: number; method: string; params: unknown }>((r) => {
    ws.onmessage = (e) => r(JSON.parse(String(e.data)));
  });
  const resultPromise = d.requestSocket<{ pong: boolean }>(serverWs, "ping", { hi: true });
  const req = await received;
  expect(req.method).toBe("ping");
  expect(req.params).toEqual({ hi: true });

  ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pong: true } }));
  expect(await resultPromise).toEqual({ pong: true });
  ws.close(); d.stop();
});

test("requestSocket rejects with the server's error message", async () => {
  const d = createDaemon({ root: "/tmp" });
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;

  const received = new Promise<{ id: number }>((r) => { ws.onmessage = (e) => r(JSON.parse(String(e.data))); });
  const resultPromise = d.requestSocket(serverWs, "ping", {});
  const req = await received;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: 1, message: "denied" } }));
  await expect(resultPromise).rejects.toThrow("denied");
  ws.close(); d.stop();
});

test("requestSocket rejects in-flight requests when the socket disconnects", async () => {
  const d = createDaemon({ root: "/tmp" });
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;

  const gotRequest = new Promise<void>((r) => { ws.onmessage = () => r(); });
  const resultPromise = d.requestSocket(serverWs, "ping", {});
  await gotRequest;
  ws.close();
  await expect(resultPromise).rejects.toThrow("socket closed");
  d.stop();
});

test("onSocketClose hooks fire with the closing socket", async () => {
  const d = createDaemon({ root: "/tmp" });
  const closed: unknown[] = [];
  d.onSocketClose((ws) => closed.push(ws));
  const ws = await connect(d.port, d.token);
  await new Promise((r) => setTimeout(r, 20));
  const serverWs = [...d.sockets][0]!;
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  expect(closed).toEqual([serverWs]);
  d.stop();
});

test("delivers client notifications to a registered notification handler", async () => {
  const d = createDaemon({ root: "/tmp" });
  const seen: unknown[] = [];
  d.rpc.registerNotification("ping", (p) => seen.push(p));
  const ws = await connect(d.port, d.token);
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: { n: 1 } }));
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toEqual([{ n: 1 }]);
  ws.close(); d.stop();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/server.test.ts`
Expected: FAIL — `d.requestSocket is not a function`, `d.onSocketClose is not a function`, `d.sockets` is `undefined`.

- [ ] **Step 3: Implement**

Replace the contents of `packages/daemon/src/server.ts`:

```ts
import { randomBytes } from "node:crypto";
import { parseMessage } from "@zero/protocol";
import { RpcServer } from "./rpc";

export interface DaemonOptions { root: string; port?: number; token?: string; webDist?: string; gatewayPort?: number }

export function createDaemon(opts: DaemonOptions) {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const rpc = new RpcServer();
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();
  const closeHooks = new Set<(ws: Bun.ServerWebSocket<unknown>) => void>();

  let nextReverseId = 1;
  const reversePending = new Map<number, {
    resolve: (v: unknown) => void; reject: (e: Error) => void; ws: Bun.ServerWebSocket<unknown>;
  }>();

  function requestSocket<R>(ws: Bun.ServerWebSocket<unknown>, method: string, params?: unknown): Promise<R> {
    const id = nextReverseId++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<R>((resolve, reject) =>
      reversePending.set(id, { resolve: resolve as (v: unknown) => void, reject, ws }));
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/rpc") {
        if (url.searchParams.get("token") !== token)
          return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (opts.webDist) {
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = Bun.file(opts.webDist + path);
        const index = Bun.file(opts.webDist + "/index.html");
        return file.exists().then(async (ok) => {
          if (ok) return new Response(file);
          if (await index.exists()) return new Response(index);
          return new Response(
            "zero web UI is not built. Run `bun run --filter @zero/web build` (or ./scripts/install.sh) and retry.",
            { status: 500 },
          );
        });
      }
      return new Response("zero daemon", { status: 200 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) {
        sockets.delete(ws);
        for (const [id, pending] of reversePending) {
          if (pending.ws === ws) {
            reversePending.delete(id);
            pending.reject(new Error("socket closed"));
          }
        }
        for (const hook of closeHooks) hook(ws);
      },
      async message(ws, raw) {
        const str = String(raw);
        let parsed;
        try { parsed = parseMessage(str); } catch { parsed = undefined; }
        // A response-shaped message (has result/error, no method) with no
        // matching registered method dispatch answers one of *our* reverse
        // requests to this socket, not a client-issued call.
        if (parsed && !("method" in parsed) && "id" in parsed) {
          const pending = reversePending.get(parsed.id);
          if (pending) {
            reversePending.delete(parsed.id);
            if (parsed.error) pending.reject(new Error(parsed.error.message));
            else pending.resolve(parsed.result);
            return;
          }
        }
        const reply = await rpc.dispatch(str, { ws });
        if (reply) ws.send(reply);
      },
    },
  });

  return {
    rpc, token, port: server.port as number, sockets,
    requestSocket,
    onSocketClose(fn: (ws: Bun.ServerWebSocket<unknown>) => void) { closeHooks.add(fn); },
    broadcast(method: string, params: unknown) {
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
      for (const ws of sockets) ws.send(msg);
    },
    stop() { server.stop(true); },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/server.test.ts`
Expected: all PASS (8 existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/server.ts packages/daemon/src/server.test.ts
git commit -m "feat(daemon): reverse-RPC requestSocket and socket-close hooks"
```

---

### Task 4: `NanoHostRegistry`

**Files:**
- Create: `packages/daemon/src/nanoHost.ts`
- Test: `packages/daemon/src/nanoHost.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ChatToolSpec`, `ChatDelta` (`@zero/core`, existing);
  a `requestSocket`-shaped function (Task 3's `daemon.requestSocket`).
- Produces:
  ```ts
  export class NanoHostRegistry {
    constructor(requestSocket: <R>(ws: unknown, method: string, params?: unknown) => Promise<R>);
    register(ws: unknown): void;
    unregister(ws: unknown): void;
    available(): boolean;
    handleChatDelta(params: { requestId: string; delta: ChatDelta }): void;
    chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/nanoHost.test.ts`:

```ts
import { expect, test } from "bun:test";
import { NanoHostRegistry } from "./nanoHost";

test("available() reflects registered sockets", () => {
  const registry = new NanoHostRegistry(async () => { throw new Error("unused"); });
  expect(registry.available()).toBe(false);
  registry.register("sock-a");
  expect(registry.available()).toBe(true);
  registry.unregister("sock-a");
  expect(registry.available()).toBe(false);
});

test("chat() targets the most-recently-registered socket", async () => {
  const seen: unknown[] = [];
  const registry = new NanoHostRegistry(async (ws, method, params) => {
    seen.push({ ws, method, params });
    return { done: true };
  });
  registry.register("a");
  registry.register("b");
  for await (const _ of registry.chat([], [], new AbortController().signal)) { /* drain */ }
  expect(seen).toHaveLength(1);
  expect((seen[0] as { ws: string }).ws).toBe("b");
});

test("chat() falls back to the remaining socket after the newest one unregisters", async () => {
  const seen: unknown[] = [];
  const registry = new NanoHostRegistry(async (ws) => { seen.push(ws); return { done: true }; });
  registry.register("a");
  registry.register("b");
  registry.unregister("b");
  for await (const _ of registry.chat([], [], new AbortController().signal)) { /* drain */ }
  expect(seen).toEqual(["a"]);
});

test("chat() throws when no host is registered", async () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  await expect((async () => {
    for await (const _ of registry.chat([], [], new AbortController().signal)) { /* */ }
  })()).rejects.toThrow("no nano host connected");
});

test("chat() surfaces a requestSocket rejection", async () => {
  const registry = new NanoHostRegistry(async () => { throw new Error("socket closed"); });
  registry.register("x");
  await expect((async () => {
    for await (const _ of registry.chat([], [], new AbortController().signal)) { /* */ }
  })()).rejects.toThrow("socket closed");
});

test("chat() yields deltas pushed via handleChatDelta before resolving", async () => {
  let capturedRequestId = "";
  const registry = new NanoHostRegistry(async (_ws, _method, params) => {
    capturedRequestId = (params as { requestId: string }).requestId;
    await new Promise((r) => setTimeout(r, 20));
    return { done: true };
  });
  registry.register("only");

  const results: unknown[] = [];
  const consume = (async () => {
    for await (const d of registry.chat([], [], new AbortController().signal)) results.push(d);
  })();

  await new Promise((r) => setTimeout(r, 5));
  registry.handleChatDelta({ requestId: capturedRequestId, delta: { text: "hi" } });
  registry.handleChatDelta({ requestId: capturedRequestId, delta: { text: " there" } });
  await consume;

  expect(results).toEqual([{ text: "hi" }, { text: " there" }]);
});

test("handleChatDelta for an unknown requestId is a no-op", () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  expect(() => registry.handleChatDelta({ requestId: "ghost", delta: { text: "x" } })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/nanoHost.test.ts`
Expected: FAIL — module `./nanoHost` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/nanoHost.ts`:

```ts
import type { ChatMessage, ChatToolSpec, ChatDelta } from "@zero/core";

export type RequestSocketFn = <R>(ws: unknown, method: string, params?: unknown) => Promise<R>;

/** Tracks which connected browser tab(s) can answer reverse `nano/chat`
 * calls, always routing to the most-recently-registered (foreground) one.
 * Web clients register while visible and unregister on hidden/close, so
 * closing or backgrounding the active tab hands off to another open one
 * instead of killing the bridge. */
export class NanoHostRegistry {
  #sockets: unknown[] = [];
  #deltaListeners = new Map<string, (delta: ChatDelta) => void>();

  constructor(private requestSocket: RequestSocketFn) {}

  register(ws: unknown) {
    this.#sockets = this.#sockets.filter((s) => s !== ws);
    this.#sockets.push(ws);
  }

  unregister(ws: unknown) {
    this.#sockets = this.#sockets.filter((s) => s !== ws);
  }

  available(): boolean {
    return this.#sockets.length > 0;
  }

  handleChatDelta(params: { requestId: string; delta: ChatDelta }) {
    this.#deltaListeners.get(params.requestId)?.(params.delta);
  }

  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    const ws = this.#sockets.at(-1);
    if (!ws) throw new Error("no nano host connected");

    const requestId = crypto.randomUUID();
    const pending: ChatDelta[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;

    this.#deltaListeners.set(requestId, (delta) => {
      pending.push(delta);
      const w = wake; wake = null; w?.();
    });

    const done = this.requestSocket<{ done: true }>(ws, "nano/chat", { requestId, messages, tools })
      .catch((e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); })
      .finally(() => { finished = true; const w = wake; wake = null; w?.(); });

    try {
      while (true) {
        if (pending.length) { yield pending.shift()!; continue; }
        if (finished || signal.aborted) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      await done;
      if (failure) throw failure;
    } finally {
      this.#deltaListeners.delete(requestId);
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/nanoHost.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/nanoHost.ts packages/daemon/src/nanoHost.test.ts
git commit -m "feat(daemon): NanoHostRegistry routes reverse chat calls to the foreground tab"
```

---

### Task 5: Wire `nano/register`, `nano/unregister`, `nano/chatDelta` in `main.ts`

**Files:**
- Modify: `packages/daemon/src/main.ts`
- Test: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Consumes: `NanoHostRegistry` (Task 4), `daemon.requestSocket`/`daemon.onSocketClose`
  (Task 3), `ChatDelta` (`@zero/core`).
- Produces: `startZero(...)`'s returned object gains a `nanoHost: NanoHostRegistry`
  member; three new RPC registrations (`nano/register`, `nano/unregister`,
  notification `nano/chatDelta`) become part of the daemon's method table.

- [ ] **Step 1: Write the failing tests**

Append to `packages/daemon/src/main.test.ts`:

```ts
test("nano/register attaches this socket as the nano host; nano/unregister detaches it", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  expect(d.nanoHost.available()).toBe(false);
  await client.request("nano/register");
  expect(d.nanoHost.available()).toBe(true);
  await client.request("nano/unregister");
  expect(d.nanoHost.available()).toBe(false);

  ws.close(); d.stop();
});

test("nano host registration clears automatically when the socket disconnects", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  await client.request("nano/register");
  expect(d.nanoHost.available()).toBe(true);

  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  expect(d.nanoHost.available()).toBe(false);
  d.stop();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: FAIL — `nano/register` is an unknown method (`-32601`); `d.nanoHost` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/daemon/src/main.ts`:

1. Change the existing line
   `import { AgentRuntime, ProviderGateway, OpenAICompatProvider } from "@zero/core";`
   to add `type ChatDelta`:
```ts
import { AgentRuntime, ProviderGateway, OpenAICompatProvider, type ChatDelta } from "@zero/core";
```
   and add a new import line for the registry:
```ts
import { NanoHostRegistry } from "./nanoHost";
```

2. Right after `const agentClient = createAgentRuntimeClient(sessions);` (around line 28), add:
```ts
  // Wrapped rather than passing daemon.requestSocket directly: that
  // function's `ws` parameter is typed as the concrete
  // Bun.ServerWebSocket<unknown>, which under strictFunctionTypes is not
  // assignable to NanoHostRegistry's intentionally opaque `unknown` ws
  // parameter (contravariant parameter checking). The wrapper's own
  // signature is declared exactly as NanoHostRegistry expects, so the cast
  // lives here in one place instead of leaking into nanoHost.ts or its tests.
  const nanoHost = new NanoHostRegistry((ws, method, params) =>
    daemon.requestSocket(ws as Bun.ServerWebSocket<unknown>, method, params));
  daemon.onSocketClose((ws) => nanoHost.unregister(ws));

  daemon.rpc.register("nano/register", z.object({}).optional().transform(() => ({})),
    async (_p, ctx) => { if (ctx) nanoHost.register(ctx.ws); return {}; });
  daemon.rpc.register("nano/unregister", z.object({}).optional().transform(() => ({})),
    async (_p, ctx) => { if (ctx) nanoHost.unregister(ctx.ws); return {}; });
  daemon.rpc.registerNotification("nano/chatDelta", (params) => {
    nanoHost.handleChatDelta(params as { requestId: string; delta: ChatDelta });
  });
```

3. In the returned object at the bottom of `startZero` (currently
   `return { ...daemon, pluginsReady, gatewayInfo, stop: ... }`), add
   `nanoHost`:
```ts
  return {
    ...daemon,
    pluginsReady,
    gatewayInfo,
    nanoHost,
    stop: () => {
      unwatch();
      pty.closeAll();
      lsp.dispose();
      stopGateway?.();
      stop();
    },
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: PASS on the two new tests (pre-existing environmental failures around
"no chat model available" are unrelated and unaffected — see Global
Constraints / this repo's known baseline).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/main.ts packages/daemon/src/main.test.ts
git commit -m "feat(daemon): wire nano/register, nano/unregister, nano/chatDelta"
```

---

### Task 6: `nanoTools.ts` — constrained-decoding tool emulation

**Files:**
- Create: `packages/core/src/providers/nanoTools.ts`
- Test: `packages/core/src/providers/nanoTools.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ChatToolSpec`, `ChatDelta` (`../chatTypes`, existing).
- Produces: `buildToolResponseConstraint(tools: ChatToolSpec[]): object`;
  `parseNanoToolResponse(raw: string, tools: ChatToolSpec[]): ChatDelta`.
  Both re-exported from `@zero/core`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/providers/nanoTools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/providers/nanoTools.test.ts`
Expected: FAIL — module `./nanoTools` does not exist.

- [ ] **Step 3: Implement**

Create `packages/core/src/providers/nanoTools.ts`:

```ts
import type { ChatToolSpec, ChatDelta } from "../chatTypes";

/** A JSON Schema for the Prompt API's `responseConstraint`: forces Nano's
 * output into either a plain answer or a call to one of `tools`, since
 * Nano has no native tool-calling head. */
export function buildToolResponseConstraint(tools: ChatToolSpec[]): object {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["answer", "tool_call"] },
      text: { type: "string" },
      tool: { type: "string", enum: tools.map((t) => t.name) },
      input: { type: "object" },
    },
    required: ["kind"],
  };
}

/** Parses Nano's constrained JSON output. A tool name outside the offered
 * set, or output that isn't valid JSON at all (the model ignored the
 * constraint), degrades to a plain-text answer rather than throwing — a
 * small-model capability limit, not a plumbing failure. */
export function parseNanoToolResponse(raw: string, tools: ChatToolSpec[]): ChatDelta {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; text?: string; tool?: string; input?: unknown };
    if (parsed.kind === "tool_call" && typeof parsed.tool === "string" && tools.some((t) => t.name === parsed.tool)) {
      return { toolCalls: [{ id: crypto.randomUUID(), name: parsed.tool, args: parsed.input ?? {} }] };
    }
    return { text: typeof parsed.text === "string" ? parsed.text : raw };
  } catch {
    return { text: raw };
  }
}
```

Add to `packages/core/src/index.ts`, after the `ChromeNanoProvider` export line:
```ts
export { buildToolResponseConstraint, parseNanoToolResponse } from "./providers/nanoTools";
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/core`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/nanoTools.ts packages/core/src/providers/nanoTools.test.ts packages/core/src/index.ts
git commit -m "feat(core): constrained-decoding tool-call emulation for Nano"
```

---

### Task 7: `ChromeNanoProvider` — session reuse and tool-aware `chat()`

**Files:**
- Modify: `packages/core/src/providers/chromeNano.ts`
- Test: `packages/core/src/providers/chromeNano.test.ts`

**Interfaces:**
- Consumes: `buildToolResponseConstraint`, `parseNanoToolResponse` (Task 6).
- Produces: `ChromeNanoProvider.chat()` behavior changes (signature
  unchanged: `chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta>`).
  `supportsTools()` stays `false` (no change — do not touch that method).
  `NanoSession.promptStreaming` gains an optional `responseConstraint` field
  in its options bag.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/providers/chromeNano.test.ts`:

```ts
test("chat() only sends the new turn on a second call, reusing the session", async () => {
  let createCalls = 0;
  const prompts: string[] = [];
  const api = {
    availability: async () => "available" as const,
    create: async () => {
      createCalls++;
      return {
        inputQuota: 6144,
        async *promptStreaming(input: string) { prompts.push(input); yield "ok"; },
        destroy() {},
      };
    },
  };
  const provider = new ChromeNanoProvider(api);
  const base = [
    { role: "system" as const, content: "Be helpful.", createdAt: 0 },
    { role: "user" as const, content: "hello", createdAt: 1 },
  ];
  for await (const _ of provider.chat(base, [], new AbortController().signal)) { /* drain */ }

  const grown = [
    ...base,
    { role: "assistant" as const, content: "hi", createdAt: 2 },
    { role: "user" as const, content: "more", createdAt: 3 },
  ];
  for await (const _ of provider.chat(grown, [], new AbortController().signal)) { /* drain */ }

  expect(createCalls).toBe(1);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).not.toContain("Be helpful.");
  expect(prompts[1]).toContain("user: more");
});

test("chat() recreates the session when the conversation resets (shorter history)", async () => {
  let createCalls = 0;
  const api = {
    availability: async () => "available" as const,
    create: async () => {
      createCalls++;
      return { inputQuota: 6144, async *promptStreaming() { yield "ok"; }, destroy() {} };
    },
  };
  const provider = new ChromeNanoProvider(api);
  const long = [
    { role: "system" as const, content: "s", createdAt: 0 },
    { role: "user" as const, content: "a", createdAt: 1 },
    { role: "assistant" as const, content: "b", createdAt: 2 },
  ];
  for await (const _ of provider.chat(long, [], new AbortController().signal)) { /* drain */ }
  const shorter = [{ role: "user" as const, content: "new convo", createdAt: 10 }];
  for await (const _ of provider.chat(shorter, [], new AbortController().signal)) { /* drain */ }
  expect(createCalls).toBe(2);
});

test("chat() with tools requests constrained decoding and parses a tool_call", async () => {
  let capturedConstraint: unknown;
  const api = {
    availability: async () => "available" as const,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(_input: string, opts?: { responseConstraint?: object }) {
        capturedConstraint = opts?.responseConstraint;
        yield JSON.stringify({ kind: "tool_call", tool: "fs_read", input: { path: "a.ts" } });
      },
      destroy() {},
    }),
  };
  const provider = new ChromeNanoProvider(api);
  const tools = [{ name: "fs_read", description: "read", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "read a.ts", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toHaveLength(1);
  expect(deltas[0]!.toolCalls![0]!.name).toBe("fs_read");
  expect(capturedConstraint).toBeTruthy();
});

test("chat() with tools falls back to plain text when the model ignores the constraint", async () => {
  const api = {
    availability: async () => "available" as const,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming() { yield "I refuse to use tools."; },
      destroy() {},
    }),
  };
  const provider = new ChromeNanoProvider(api);
  const tools = [{ name: "fs_read", description: "read", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "hi", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toEqual([{ text: "I refuse to use tools." }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/providers/chromeNano.test.ts`
Expected: FAIL — session-reuse tests see `createCalls` too high/low, and the
tools tests get plain streamed text instead of parsed `toolCalls`
(`capturedConstraint` is `undefined`).

- [ ] **Step 3: Implement**

Replace the contents of `packages/core/src/providers/chromeNano.ts`:

```ts
import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";
import { buildToolResponseConstraint, parseNanoToolResponse } from "./nanoTools";

export interface NanoSession {
  promptStreaming(input: string, opts?: { signal?: AbortSignal; responseConstraint?: object }): AsyncIterable<string>;
  destroy(): void;
  inputQuota?: number;
}
export interface NanoApi {
  availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(opts?: { monitor?: (m: EventTarget) => void }): Promise<NanoSession>;
}

export async function probeNano(api: NanoApi | undefined): Promise<"ready" | "downloadable" | "unavailable"> {
  if (!api) return "unavailable";
  const state = await api.availability().catch(() => "unavailable" as const);
  if (state === "available") return "ready";
  if (state === "downloadable" || state === "downloading") return "downloadable";
  return "unavailable";
}

export class ChromeNanoProvider implements ChatCapableProvider {
  id = "chrome-nano";
  #session: NanoSession | null = null;
  #sentCount = 0;
  constructor(private api: NanoApi | undefined) {}

  async available(): Promise<boolean> {
    return (await probeNano(this.api)) === "ready";
  }

  capabilities(): ModelCapabilities {
    return {
      id: this.id, supportsFim: false,
      contextWindowTokens: Math.min(this.#session?.inputQuota ?? 6144, 6144),
    };
  }

  async *complete(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    if (!this.api) return;
    this.#session ??= await this.api.create();
    for await (const chunk of this.#session.promptStreaming(prompt, { signal })) {
      if (signal.aborted) return;
      yield chunk;
    }
  }

  supportsTools(): boolean {
    return false;
  }

  /** Reuses the live session across calls, sending only the messages added
   * since the last call (a real conversation, not a re-flattened
   * transcript). A shorter `messages` array than last seen means the
   * conversation reset, so the session is recreated. When `tools` is
   * non-empty, requests Nano's `responseConstraint` constrained decoding
   * (independent of `supportsTools()`, which stays `false` for every other
   * caller) and parses the accumulated output into a single ChatDelta. */
  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    if (!this.api) return;
    if (messages.length < this.#sentCount) {
      this.#session?.destroy();
      this.#session = null;
      this.#sentCount = 0;
    }
    this.#session ??= await this.api.create();
    const turn = messages.slice(this.#sentCount);
    this.#sentCount = messages.length;
    const prompt = turn.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\nassistant:";

    if (tools.length > 0) {
      let full = "";
      for await (const chunk of this.#session.promptStreaming(prompt, {
        signal, responseConstraint: buildToolResponseConstraint(tools),
      })) {
        if (signal.aborted) return;
        full += chunk;
      }
      if (signal.aborted) return;
      yield parseNanoToolResponse(full, tools);
      return;
    }

    for await (const chunk of this.#session.promptStreaming(prompt, { signal })) {
      if (signal.aborted) return;
      yield { text: chunk };
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/core/src/providers/chromeNano.test.ts`
Expected: all PASS (existing 6 tests, including the unmodified "chat() renders
messages into a transcript..." test — its expectations still hold since the
first call on a fresh provider sends `messages.slice(0)`, the full history —
plus the 4 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/providers/chromeNano.ts packages/core/src/providers/chromeNano.test.ts
git commit -m "fix(core): ChromeNanoProvider reuses session state and emulates tool calls"
```

---

### Task 8: `NanoBridgeProvider` and gateway wiring

**Files:**
- Create: `packages/daemon/src/nanoBridgeProvider.ts`
- Test: `packages/daemon/src/nanoBridgeProvider.test.ts`
- Modify: `packages/daemon/src/main.ts`

**Interfaces:**
- Consumes: `ChatCapableProvider`, `ChatMessage`, `ChatToolSpec`, `ChatDelta`,
  `ModelCapabilities` (`@zero/core`, existing); `NanoHostRegistry` (Task 4).
- Produces: `class NanoBridgeProvider implements ChatCapableProvider` with
  `id = "nano-bridge"`. Wired into `startModelGateway`'s `ProviderGateway`
  in `main.ts` — and *only* there.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/nanoBridgeProvider.test.ts`:

```ts
import { expect, test } from "bun:test";
import { NanoBridgeProvider } from "./nanoBridgeProvider";
import { NanoHostRegistry } from "./nanoHost";

test("available() mirrors the registry", async () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  const provider = new NanoBridgeProvider(registry);
  expect(await provider.available()).toBe(false);
  registry.register("x");
  expect(await provider.available()).toBe(true);
});

test("supportsTools() is true", () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  expect(new NanoBridgeProvider(registry).supportsTools()).toBe(true);
});

test("id is nano-bridge and capabilities report a small context window", () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  const provider = new NanoBridgeProvider(registry);
  expect(provider.id).toBe("nano-bridge");
  expect(provider.capabilities()).toEqual({ id: "nano-bridge", supportsFim: false, contextWindowTokens: 6144 });
});

test("chat() delegates to the registry", async () => {
  const registry = new NanoHostRegistry(async () => ({ done: true }));
  registry.register("x");
  const provider = new NanoBridgeProvider(registry);
  const results: unknown[] = [];
  for await (const d of provider.chat([], [], new AbortController().signal)) results.push(d);
  expect(results).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/nanoBridgeProvider.test.ts`
Expected: FAIL — module `./nanoBridgeProvider` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/nanoBridgeProvider.ts`:

```ts
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta, ModelCapabilities } from "@zero/core";
import type { NanoHostRegistry } from "./nanoHost";

/** The daemon-side `ChatCapableProvider` backed by whichever browser tab is
 * currently registered as the Nano host. Wired only into the model
 * gateway's ProviderGateway (never AgentRuntime/chat-turn) — see the M7
 * design spec section 7. */
export class NanoBridgeProvider implements ChatCapableProvider {
  id = "nano-bridge";
  constructor(private registry: NanoHostRegistry) {}

  async available(): Promise<boolean> {
    return this.registry.available();
  }

  capabilities(): ModelCapabilities {
    return { id: this.id, supportsFim: false, contextWindowTokens: 6144 };
  }

  supportsTools(): boolean {
    return true;
  }

  // The model gateway only ever calls chat(); complete() exists to satisfy
  // ModelProvider and is intentionally never used.
  async *complete(): AsyncIterable<string> { /* unused */ }

  chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    return this.registry.chat(messages, tools, signal);
  }
}
```

Then in `packages/daemon/src/main.ts`:

1. Add the import (near the other daemon-local imports):
```ts
import { NanoBridgeProvider } from "./nanoBridgeProvider";
```

2. In the `if (opts.gatewayPort !== undefined)` block (around line 252),
   change:
```ts
    const providers = await buildProviders();
    const gw = startModelGateway({ port: opts.gatewayPort, gateway: new ProviderGateway(providers) });
```
   to:
```ts
    const providers = await buildProviders();
    const gw = startModelGateway({
      port: opts.gatewayPort,
      gateway: new ProviderGateway([new NanoBridgeProvider(nanoHost), ...providers]),
    });
```
   (Nano listed first so `ProviderGateway.pick()`'s tool-supporting-provider
   preference picks it over the Ollama fallback whenever a host is attached
   — the whole point of this milestone. The `chat/turn`/`AgentRuntime`
   provider list built at the other `buildProviders()` call site, used by
   `runtimeFor`, is untouched.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/nanoBridgeProvider.test.ts packages/daemon/src/main.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/nanoBridgeProvider.ts packages/daemon/src/nanoBridgeProvider.test.ts packages/daemon/src/main.ts
git commit -m "feat(daemon): NanoBridgeProvider, wired into the model gateway only"
```

---

### Task 9: `GET /health` on the model gateway

**Files:**
- Modify: `packages/daemon/src/modelGateway.ts`
- Test: `packages/daemon/src/modelGateway.test.ts`

**Interfaces:**
- Consumes: `ProviderGateway.pick()` (existing).
- Produces: `GET /health` on the gateway's HTTP server, returning
  `{ nanoHostConnected: boolean; provider: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/daemon/src/modelGateway.test.ts`:

```ts
test("GET /health reports the picked provider", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ nanoHostConnected: false, provider: "stub" });
  gw.stop();
});

test("GET /health reports no provider when none is available", async () => {
  const unavailable = { ...stubProvider("x"), available: async () => false };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([unavailable]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
  expect(await res.json()).toEqual({ nanoHostConnected: false, provider: null });
  gw.stop();
});

test("GET /health reports nanoHostConnected when the nano bridge is picked", async () => {
  const nano = { ...stubProvider("x"), id: "nano-bridge" };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([nano]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/health`);
  expect(await res.json()).toEqual({ nanoHostConnected: true, provider: "nano-bridge" });
  gw.stop();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/modelGateway.test.ts`
Expected: FAIL — `/health` currently falls through to the `not found` 404
branch.

- [ ] **Step 3: Implement**

In `packages/daemon/src/modelGateway.ts`, add a branch before the existing
`/v1/messages` check inside `fetch(req)`:

```ts
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        const provider = await opts.gateway.pick();
        return Response.json({ nanoHostConnected: provider?.id === "nano-bridge", provider: provider?.id ?? null });
      }
      if (url.pathname !== "/v1/messages" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      // ...rest of the existing handler is unchanged
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/modelGateway.test.ts`
Expected: all PASS (5 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/modelGateway.ts packages/daemon/src/modelGateway.test.ts
git commit -m "feat(daemon): GET /health on the model gateway"
```

---

### Task 10: Full bridge integration tests

**Files:**
- Create: `packages/daemon/src/nanoBridge.test.ts`

**Interfaces:**
- Consumes: `startZero` (existing, now producing `nanoHost` and a
  Nano-bridge-aware gateway per Tasks 5 and 8), `RpcClient` (`@zero/protocol`,
  Task 1's `onRequest`/`notify`), `ChatDelta` (`@zero/core`).
- Produces: no new production code — this is the capstone test proving the
  whole chain (reverse-RPC → `NanoHostRegistry` → `NanoBridgeProvider` →
  `ProviderGateway` → `modelGateway`'s SSE synthesis) works end to end
  through a real daemon and real WebSockets.

- [ ] **Step 1: Write the tests**

Create `packages/daemon/src/nanoBridge.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, type SocketLike } from "@zero/protocol";
import type { ChatDelta } from "@zero/core";
import { startZero } from "./main";
import { settingsPath } from "./paths";
import { useTempZeroHome } from "./testSupport/zeroHome";

useTempZeroHome();

function wsAdapter(ws: WebSocket): SocketLike {
  const s: SocketLike = { send: (d) => ws.send(d), onmessage: null };
  ws.onmessage = (e) => s.onmessage?.(String(e.data));
  return s;
}

async function openClient(port: number, token: string) {
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  return { ws, client: new RpcClient(wsAdapter(ws)) };
}

test("a browser answering nano/chat serves a full /v1/messages round trip through the gateway", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });
  const { ws, client } = await openClient(d.port, d.token);

  client.onRequest("nano/chat", async (params) => {
    const { requestId } = params as { requestId: string };
    client.notify("nano/chatDelta", { requestId, delta: { text: "Hello" } satisfies ChatDelta });
    client.notify("nano/chatDelta", { requestId, delta: { text: " world" } satisfies ChatDelta });
    return { done: true };
  });
  await client.request("nano/register");

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("Hello world");
  expect(text).toContain('"stop_reason":"end_turn"');
  expect(text).toContain("event: message_stop");

  ws.close(); d.stop();
});

test("a tool_use turn round-trips through the gateway as tool_use content blocks", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });
  const { ws, client } = await openClient(d.port, d.token);

  client.onRequest("nano/chat", async (params) => {
    const { requestId } = params as { requestId: string };
    client.notify("nano/chatDelta", {
      requestId,
      delta: { toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }] } satisfies ChatDelta,
    });
    return { done: true };
  });
  await client.request("nano/register");

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "read a.ts" }],
      tools: [{ name: "fs_read", description: "read a file", input_schema: { type: "object" } }],
    }),
  });
  const text = await res.text();
  expect(text).toContain('"type":"tool_use"');
  expect(text).toContain('"name":"fs_read"');
  expect(text).toContain('"stop_reason":"tool_use"');

  ws.close(); d.stop();
});

test("no browser attached and no reachable fallback: /v1/messages returns 503", async () => {
  // Force the Ollama fallback to be reliably unreachable regardless of what
  // happens to be running on this machine (see main.test.ts's own "no chat
  // model available" tests for the same concern) - port 1 refuses instantly.
  writeFileSync(settingsPath(), JSON.stringify({ "zero.ollamaUrl": "http://127.0.0.1:1/v1" }));
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(503);
  d.stop();
});

test("nano is preferred over the Ollama fallback when a host is attached", async () => {
  // Ollama fallback is unreachable (see above) so if the response succeeds
  // at all, it can only have come from the attached Nano host.
  writeFileSync(settingsPath(), JSON.stringify({ "zero.ollamaUrl": "http://127.0.0.1:1/v1" }));
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root, gatewayPort: 0 });
  const { ws, client } = await openClient(d.port, d.token);
  client.onRequest("nano/chat", async (params) => {
    const { requestId } = params as { requestId: string };
    client.notify("nano/chatDelta", { requestId, delta: { text: "from nano" } satisfies ChatDelta });
    return { done: true };
  });
  await client.request("nano/register");

  const res = await fetch(`http://127.0.0.1:${d.gatewayInfo!.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": d.gatewayInfo!.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("from nano");

  ws.close(); d.stop();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/nanoBridge.test.ts`
Expected: FAIL if any earlier task is incomplete (this test only passes once
Tasks 1-9 are all in place). If Tasks 1-9 are already committed, this may
already pass on first run — still execute Steps 1-5 to lock it in as a
regression test.

- [ ] **Step 3: (No implementation step — this task is test-only.)**

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/nanoBridge.test.ts`
Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/nanoBridge.test.ts
git commit -m "test(daemon): end-to-end Nano bridge integration tests"
```

---

### Task 11: Web-side Nano host (`packages/web/src/nanoHost.ts`)

**Files:**
- Create: `packages/web/src/nanoHost.ts`
- Test: `packages/web/src/nanoHost.test.ts`

**Interfaces:**
- Consumes: `ChromeNanoProvider`, `probeNano`, `NanoApi`, `ChatMessage`,
  `ChatToolSpec` (`@zero/core`, existing); an `RpcClient`-shaped object with
  `onRequest`/`notify`/`request` (Task 1).
- Produces:
  ```ts
  export interface VisibilityDoc {
    visibilityState: "visible" | "hidden";
    addEventListener(type: "visibilitychange", handler: () => void): void;
  }
  export interface NanoHostOpts {
    client: { request<R>(method: string, params?: unknown): Promise<R>; notify(method: string, params?: unknown): void; onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void };
    nanoApi: NanoApi | undefined;
    doc?: VisibilityDoc;
  }
  export function setupNanoHost(opts: NanoHostOpts): void;
  ```
  No dispose/cleanup return value — this is set up once for the daemon-mode
  app's lifetime, matching how `createCompletion` in `completionSetup.ts` is
  also never torn down.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/nanoHost.test.ts`:

```ts
import { expect, test } from "bun:test";
import { setupNanoHost } from "./nanoHost";
import type { NanoApi } from "@zero/core";

function fakeClient() {
  const sent: { method: string; params: unknown }[] = [];
  const requested: { method: string; params: unknown }[] = [];
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    sent, requested,
    notify: (method: string, params: unknown) => { sent.push({ method, params }); },
    request: async (method: string, params?: unknown) => { requested.push({ method, params }); return {}; },
    onRequest: (method: string, handler: (params: unknown) => Promise<unknown>) => requestHandlers.set(method, handler),
    __invoke: (method: string, params: unknown) => requestHandlers.get(method)!(params),
  };
}

function fakeDoc(initial: "visible" | "hidden") {
  let handler: (() => void) | null = null;
  const doc = {
    visibilityState: initial as "visible" | "hidden",
    addEventListener: (_type: string, h: () => void) => { handler = h; },
    fire(state: "visible" | "hidden") { doc.visibilityState = state; handler?.(); },
  };
  return doc;
}

function readyNanoApi(): NanoApi {
  return {
    availability: async () => "available",
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string) { yield "ok:" + input.slice(0, 3); },
      destroy() {},
    }),
  };
}

test("registers once Nano is ready and the doc is visible", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc: fakeDoc("visible") });
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested).toEqual([{ method: "nano/register", params: undefined }]);
});

test("does not register when Nano is unavailable", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: undefined, doc: fakeDoc("visible") });
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested).toEqual([]);
});

test("does not register while the tab starts hidden", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc: fakeDoc("hidden") });
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested).toEqual([]);
});

test("unregisters on visibilitychange to hidden, re-registers on visible", async () => {
  const client = fakeClient();
  const doc = fakeDoc("visible");
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc });
  await new Promise((r) => setTimeout(r, 0));
  doc.fire("hidden");
  await new Promise((r) => setTimeout(r, 0));
  doc.fire("visible");
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested.map((r) => r.method)).toEqual(["nano/register", "nano/unregister", "nano/register"]);
});

test("answers nano/chat by running ChromeNanoProvider locally and forwarding deltas as notifications", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc: fakeDoc("visible") });
  const result = await client.__invoke("nano/chat", {
    requestId: "r1",
    messages: [{ role: "user", content: "hey", createdAt: 0 }],
    tools: [],
  });
  expect(result).toEqual({ done: true });
  expect(client.sent).toEqual([{ method: "nano/chatDelta", params: { requestId: "r1", delta: { text: "ok:use" } } }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/web/src/nanoHost.test.ts`
Expected: FAIL — module `./nanoHost` does not exist.

- [ ] **Step 3: Implement**

Create `packages/web/src/nanoHost.ts`:

```ts
import { ChromeNanoProvider, probeNano, type NanoApi, type ChatMessage, type ChatToolSpec } from "@zero/core";

export interface VisibilityDoc {
  visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", handler: () => void): void;
}

export interface NanoHostClient {
  request<R>(method: string, params?: unknown): Promise<R>;
  notify(method: string, params?: unknown): void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void;
}

export interface NanoHostOpts {
  client: NanoHostClient;
  nanoApi: NanoApi | undefined;
  doc?: VisibilityDoc;
}

/** Registers this daemon-mode tab as the (foreground-only) Nano host for
 * the daemon's Claude Code bridge, and answers reverse `nano/chat` calls by
 * running ChromeNanoProvider locally. Never called in Lite mode - there is
 * no daemon to register with. */
export function setupNanoHost(opts: NanoHostOpts): void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  const provider = new ChromeNanoProvider(opts.nanoApi);
  let registered = false;

  opts.client.onRequest("nano/chat", async (params) => {
    const { requestId, messages, tools } = params as { requestId: string; messages: ChatMessage[]; tools: ChatToolSpec[] };
    const controller = new AbortController();
    for await (const delta of provider.chat(messages, tools, controller.signal)) {
      opts.client.notify("nano/chatDelta", { requestId, delta });
    }
    return { done: true };
  });

  async function syncRegistration() {
    const ready = (await probeNano(opts.nanoApi)) === "ready";
    const visible = !doc || doc.visibilityState === "visible";
    if (ready && visible && !registered) {
      registered = true;
      await opts.client.request("nano/register").catch(() => { registered = false; });
    } else if ((!ready || !visible) && registered) {
      registered = false;
      await opts.client.request("nano/unregister").catch(() => {});
    }
  }

  doc?.addEventListener("visibilitychange", () => { void syncRegistration(); });
  void syncRegistration();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/web/src/nanoHost.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/nanoHost.ts packages/web/src/nanoHost.test.ts
git commit -m "feat(web): register as the foreground Nano host, answer reverse nano/chat"
```

---

### Task 12: Wire the web Nano host into `App.tsx`

**Files:**
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `setupNanoHost` (Task 11), `NanoApi` (`@zero/core`, existing).
- Produces: no new exports — `goDaemon` now calls `setupNanoHost` once a
  daemon connection is live. Lite mode (`enterLite`) is untouched.

- [ ] **Step 1: Add the import**

In `packages/web/src/App.tsx`, add near the top:
```ts
import { setupNanoHost } from "./nanoHost";
import type { NanoApi } from "@zero/core";
```

- [ ] **Step 2: Call it after a daemon connection is live**

In `goDaemon` (around line 75), change:
```ts
      setClient(conn.client);
      setCapabilities(hello.capabilities);
      setMode("ready");
```
to:
```ts
      setClient(conn.client);
      setCapabilities(hello.capabilities);
      setMode("ready");
      setupNanoHost({ client: conn.client, nanoApi: (globalThis as { LanguageModel?: NanoApi }).LanguageModel });
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS, no new errors.

- [ ] **Step 4: Manual verification**

This file has no automated test coverage today (App.tsx is verified manually
per this project's convention — see `docs/superpowers/plans/2026-08-04-m0-m1-skeleton-and-completion.md`
Task 7 for precedent). Run:
```bash
bun run --cwd packages/web build
bun packages/daemon/bin/zero.ts . &
```
Open the printed `http://127.0.0.1:4820/?token=...` URL in Chrome or Edge
with Gemini Nano available. Confirm no console errors from `nanoHost.ts`. A
full end-to-end check (a live `zero claude` session actually driving Claude
Code against this tab) is exercised manually after Task 13 lands.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/App.tsx
git commit -m "feat(web): wire the Nano host into daemon-mode boot"
```

---

### Task 13: `zero claude` launcher CLI

**Files:**
- Create: `packages/daemon/src/cli/claude.ts`
- Test: `packages/daemon/src/cli/claude.test.ts`
- Modify: `packages/daemon/bin/zero.ts`

**Interfaces:**
- Consumes: `startZero` (existing, now returning `nanoHost` and
  `gatewayInfo` per Task 5); `positionalArgs`, `parseGatewayPort`
  (`./agent`, existing).
- Produces:
  ```ts
  export function claudeLaunchBanner(opts: { webUrl: string; gatewayUrl: string; apiKey: string }): string;
  export function nanoHostStatusLine(prevAvailable: boolean, available: boolean): string | null;
  export interface ClaudeCliDeps { log?: (line: string) => void; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal }
  export function runClaudeCli(root: string, gatewayPort: number | undefined, deps?: ClaudeCliDeps): Promise<number>;
  ```
  `bin/zero.ts` gains a `zero claude [path] [--gateway-port <port>]` branch.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/cli/claude.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLaunchBanner, nanoHostStatusLine, runClaudeCli } from "./claude";
import { useTempZeroHome } from "../testSupport/zeroHome";

useTempZeroHome();

test("claudeLaunchBanner includes the web URL and the ANTHROPIC env line", () => {
  const banner = claudeLaunchBanner({ webUrl: "http://127.0.0.1:4820/?token=abc", gatewayUrl: "http://127.0.0.1:5000", apiKey: "key123" });
  expect(banner).toContain("http://127.0.0.1:4820/?token=abc");
  expect(banner).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:5000 ANTHROPIC_API_KEY=key123 claude");
});

test("nanoHostStatusLine reports only on transitions", () => {
  expect(nanoHostStatusLine(false, false)).toBeNull();
  expect(nanoHostStatusLine(false, true)).toBe("Nano host attached ✓");
  expect(nanoHostStatusLine(true, true)).toBeNull();
  expect(nanoHostStatusLine(true, false)).toBe("waiting for a Zero tab with Gemini Nano...");
});

test("runClaudeCli starts the daemon+gateway, prints the banner, and polls until aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const lines: string[] = [];
  const controller = new AbortController();
  let ticks = 0;

  const exitCode = await runClaudeCli(root, undefined, {
    log: (l) => lines.push(l),
    signal: controller.signal,
    sleep: async () => { ticks++; if (ticks >= 3) controller.abort(); },
  });

  expect(exitCode).toBe(0);
  expect(lines.some((l) => l.includes("zero ready:"))).toBe(true);
  expect(lines.some((l) => l.includes("ANTHROPIC_BASE_URL="))).toBe(true);
  expect(lines.some((l) => l.includes("waiting for a Zero tab with Gemini Nano..."))).toBe(true);
  expect(ticks).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/daemon/src/cli/claude.test.ts`
Expected: FAIL — module `./claude` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/cli/claude.ts`:

```ts
import { startZero } from "../main";

export interface ClaudeCliDeps {
  log?: (line: string) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export function claudeLaunchBanner(opts: { webUrl: string; gatewayUrl: string; apiKey: string }): string {
  return [
    `zero ready: ${opts.webUrl}`,
    `Open that URL in Chrome or Edge to attach Gemini Nano.`,
    ``,
    `ANTHROPIC_BASE_URL=${opts.gatewayUrl} ANTHROPIC_API_KEY=${opts.apiKey} claude`,
  ].join("\n");
}

/** Returns a status line only on a true->false or false->true transition,
 * so the poll loop doesn't spam identical lines every tick. */
export function nanoHostStatusLine(prevAvailable: boolean, available: boolean): string | null {
  if (available === prevAvailable) return null;
  return available ? "Nano host attached ✓" : "waiting for a Zero tab with Gemini Nano...";
}

/** Starts the daemon with its model gateway always on (unlike `zero serve`,
 * where the gateway is opt-in via --gateway-port), prints the URL to open
 * plus the ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY line, then polls Nano-host
 * attachment status until `deps.signal` aborts (real usage: Ctrl+C; tests:
 * an injected controller). */
export async function runClaudeCli(root: string, gatewayPort: number | undefined, deps: ClaudeCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const webDist = new URL("../../../web/dist", import.meta.url).pathname;
  const d = await startZero({ root, port: 4820, webDist, gatewayPort: gatewayPort ?? 0 });

  // gatewayPort is always defined above (never `undefined` passed to
  // startZero), so startZero's gateway branch always runs and gatewayInfo
  // is always set - unlike `zero serve`, where the gateway is optional.
  log(claudeLaunchBanner({
    webUrl: `http://127.0.0.1:${d.port}/?token=${d.token}`,
    gatewayUrl: `http://127.0.0.1:${d.gatewayInfo!.port}`,
    apiKey: d.gatewayInfo!.apiKey,
  }));
  log("waiting for a Zero tab with Gemini Nano...");

  let lastAvailable = false;
  while (!deps.signal?.aborted) {
    const available = d.nanoHost.available();
    const line = nanoHostStatusLine(lastAvailable, available);
    if (line) log(line);
    lastAvailable = available;
    await sleep(deps.pollIntervalMs ?? 1000);
  }
  d.stop();
  return 0;
}
```

Then in `packages/daemon/bin/zero.ts`:

1. Add the import:
```ts
import { runClaudeCli } from "../src/cli/claude";
```

2. In the `--help` text, add a line after the `serve` line:
```
  zero claude [path] [--gateway-port <port>]        start the daemon and bridge Claude Code to Gemini Nano
```

3. Add a new branch before the existing `if (argv[0] === "serve")`:
```ts
if (argv[0] === "claude") {
  const rest = argv.slice(1);
  const path = positionalArgs(rest)[0];
  const root = resolve(path ?? ".");
  const parsedGatewayPort = parseGatewayPort(rest);
  if (parsedGatewayPort === "invalid") {
    console.error("error: --gateway-port requires a numeric value");
    process.exit(1);
  }
  const exitCode = await runClaudeCli(root, parsedGatewayPort);
  process.exit(exitCode);
} else if (argv[0] === "serve") {
```
   (change the existing `if (argv[0] === "serve")` to `else if` as shown).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/daemon/src/cli/claude.test.ts && bun run typecheck`
Expected: all PASS, no typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/cli/claude.ts packages/daemon/src/cli/claude.test.ts packages/daemon/bin/zero.ts
git commit -m "feat(daemon): zero claude launcher for the Nano bridge"
```

---

### Task 14: README and version

**Files:**
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing new.
- Produces: updated docs and root version `0.7.0`.

- [ ] **Step 1: Update the Status section**

In `README.md`, after the M6 bullet (ends `...Live at [zero.varunkumar.dev](https://zero.varunkumar.dev).`),
add:

```markdown
- **M7** Zero Claude Plugin (Nano bridge): `zero claude [path]` starts the
  daemon with its model gateway always on and prints an
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` line. Open the printed URL in
  Chrome or Edge to attach that tab as the Nano host — reverse-RPC lets the
  daemon call into it, running `ChromeNanoProvider` in-browser and emulating
  tool calls via Prompt API constrained JSON decoding. Point
  `ANTHROPIC_BASE_URL` at the printed gateway and run `claude` for a fully
  offline Claude Code. Falls back to the Ollama-compatible provider when no
  tab is attached.
```

Also update the design-doc list a few lines below (after the `[Plugins]`
line) to add:
```markdown
- [M7 design](docs/superpowers/specs/2026-08-13-m7-zero-claude-plugin-design.md)
```

- [ ] **Step 2: Add a CLI usage line and a usage section**

In the "Command surface" list under `## CLI usage`, after the `zero serve`
line, add:
```markdown
- `zero claude [path] [--gateway-port <port>]` - start the daemon, bridging
  Claude Code to Gemini Nano running in an attached browser tab
```

After the `## Zero Lite` section, add:
```markdown
## Zero Claude Plugin

```
zero claude
```

prints a URL and an `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` line. Open the
URL in Chrome or Edge with Gemini Nano available, then in another terminal:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=<key> claude
```

Claude Code now runs fully offline against Nano. Only one browser tab
serves as the Nano host at a time — whichever is currently in the
foreground; closing or backgrounding it hands off to another open Zero tab
if one exists. Nano is a small model: expect a working offline agent, not
cloud-Claude parity on tool-choice accuracy.
```

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.6.0"` to `"version": "0.7.0"`.

- [ ] **Step 4: Full verify**

Run: `bun test && bun run typecheck`
Expected: all PASS except the pre-existing environmental `main.test.ts`
"no chat model available" failures noted in Global Constraints (unrelated
to this milestone; do not touch them).

Run: `bun run --cwd packages/web build`
Expected: `packages/web/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -m "chore: mark M7 Zero Claude Plugin 0.7.0"
```

---

## Self-review (spec coverage)

| Spec section | Task |
|---|---|
| Reverse-RPC (`RpcClient`) | 1 |
| Reverse-RPC (`RpcServer`, `ctx`) | 2 |
| Reverse-RPC (`server.ts`, `requestSocket`, close hooks) | 3 |
| `NanoHostRegistry`, foreground-tab routing/fallback | 4 |
| `nano/register`/`nano/unregister`/`nano/chatDelta` wiring | 5 |
| Constrained-decoding tool emulation | 6 |
| `ChromeNanoProvider` session reuse + tools-aware `chat()` | 7 |
| `supportsTools()` stays false; AgentRuntime untouched | 7, 8 |
| `NanoBridgeProvider`, gateway-only wiring | 8 |
| `GET /health` | 9 |
| Full round trip, no-host 503, mid-stream error, Nano preferred | 10 |
| Web-side registration/visibility/answering | 11 |
| Wiring into daemon-mode boot | 12 |
| `zero claude` launcher | 13 |
| README / version | 14 |
