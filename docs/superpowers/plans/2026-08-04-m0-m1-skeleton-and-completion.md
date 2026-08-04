# Zero M0+M1 (Skeleton + Completion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daemon-served browser editor that opens a project, edits and saves files, and shows inline ghost-text completions from Gemini Nano with Ollama fallback.

**Architecture:** Bun monorepo. `@zero/protocol` defines JSON-RPC types plus an isomorphic RPC client. `@zero/daemon` is a Bun.serve process (WebSocket RPC + static serving + workspace fs). `@zero/core` holds the model/context interfaces and the CompletionEngine (no DOM, no Node APIs). `@zero/web` is a Vite+React client with CodeMirror 6.

**Tech Stack:** Bun (runtime, workspaces, `bun test`), TypeScript strict, Zod, CodeMirror 6, React, Vite, `ignore` (gitignore parsing).

## Global Constraints

- All packages TypeScript `"strict": true`; ESM only.
- `@zero/core` and `@zero/protocol` must not import DOM or Node/Bun APIs. Capabilities are injected.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session token are rejected with close code 4001.
- The editor must remain fully usable when no model is available (spec section 8).
- Token estimate everywhere: `Math.ceil(chars / 4)` (spec 4.6).
- Completion context gathering budget: 50ms; keystroke debounce: 150ms; one completion request in flight (spec 4.5, 6).
- Runtime floor: Bun >= 1.1.
- Commit after every task; messages in conventional-commit style.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/{protocol,core,daemon,web}/package.json`
- Create: `packages/{protocol,core,daemon,web}/tsconfig.json`
- Create: `packages/protocol/src/index.ts` (empty export), same for core/daemon
- Test: `packages/protocol/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace layout; `bun test` runs across packages; package names `@zero/protocol`, `@zero/core`, `@zero/daemon`, `@zero/web`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "zero",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": { "test": "bun test", "typecheck": "bunx tsc -b" }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true, "module": "ESNext", "target": "ES2022",
    "moduleResolution": "bundler", "skipLibCheck": true,
    "declaration": true, "composite": true, "types": []
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.zero/
```

- [ ] **Step 2: Package manifests**

For each of protocol, core, daemon (web differs in Task 7), `packages/<name>/package.json`:
```json
{
  "name": "@zero/<name>",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```
Each `tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Each `src/index.ts`: `export {}` for now.

- [ ] **Step 3: Smoke test**

`packages/protocol/src/smoke.test.ts`:
```ts
import { expect, test } from "bun:test";
test("workspace runs tests", () => expect(1 + 1).toBe(2));
```

- [ ] **Step 4: Verify**

Run: `bun install && bun test`
Expected: 1 pass.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "chore: scaffold bun monorepo"
```

---

### Task 2: @zero/protocol message envelope

**Files:**
- Create: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/index.ts` (re-export)
- Test: `packages/protocol/src/messages.test.ts`

**Interfaces:**
- Produces:
  - `RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown }`
  - `RpcResponse { jsonrpc: "2.0"; id: number; result?: unknown; error?: RpcError }`
  - `RpcError { code: number; message: string }`
  - `RpcNotification { jsonrpc: "2.0"; method: string; params?: unknown }` (no `id`)
  - `parseMessage(raw: string): RpcRequest | RpcResponse | RpcNotification` (throws `ProtocolError`)
  - Fs method types: `FsReadParams {path}`, `FsReadResult {content}`, `FsWriteParams {path; content}`, `FsTreeResult {entries: TreeEntry[]}`, `TreeEntry {path: string; kind: "file" | "dir"}`, `FsChangedEvent {path}`.

- [ ] **Step 1: Failing test** (`messages.test.ts`)
```ts
import { expect, test } from "bun:test";
import { parseMessage, ProtocolError } from "./messages";

test("round-trips a request", () => {
  const msg = { jsonrpc: "2.0", id: 1, method: "fs/read", params: { path: "a.ts" } };
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
```

- [ ] **Step 2: Run** `bun test packages/protocol`: FAIL (module missing).

- [ ] **Step 3: Implement** (`messages.ts`)
```ts
import { z } from "zod";

export class ProtocolError extends Error {}

const request = z.object({ jsonrpc: z.literal("2.0"), id: z.number(),
  method: z.string(), params: z.unknown().optional() });
const response = z.object({ jsonrpc: z.literal("2.0"), id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional() });
const notification = z.object({ jsonrpc: z.literal("2.0"),
  method: z.string(), params: z.unknown().optional() });

export type RpcRequest = z.infer<typeof request>;
export type RpcResponse = z.infer<typeof response>;
export type RpcError = NonNullable<RpcResponse["error"]>;
export type RpcNotification = z.infer<typeof notification>;

export function parseMessage(raw: string): RpcRequest | RpcResponse | RpcNotification {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new ProtocolError("invalid json"); }
  for (const schema of [request, response, notification]) {
    const r = schema.safeParse(data);
    if (r.success) return r.data;
  }
  throw new ProtocolError("not a jsonrpc message");
}

export interface TreeEntry { path: string; kind: "file" | "dir" }
export interface FsReadParams { path: string }
export interface FsReadResult { content: string }
export interface FsWriteParams { path: string; content: string }
export interface FsTreeResult { entries: TreeEntry[] }
export interface FsChangedEvent { path: string }
```
Add `zod` to `packages/protocol/package.json` dependencies (`"zod": "^3.23.0"`), re-export everything from `index.ts`, `bun install`.

- [ ] **Step 4: Run** `bun test packages/protocol`: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(protocol): jsonrpc envelope and fs types"`

---

### Task 3: @zero/protocol RpcClient (isomorphic)

**Files:**
- Create: `packages/protocol/src/client.ts`
- Test: `packages/protocol/src/client.test.ts`

**Interfaces:**
- Consumes: `parseMessage`, envelope types (Task 2).
- Produces:
  - `interface SocketLike { send(data: string): void; onmessage: ((data: string) => void) | null }`
  - `class RpcClient { constructor(socket: SocketLike); request<R>(method: string, params?: unknown): Promise<R>; onNotification(handler: (method: string, params: unknown) => void): void }`
  - Rejected promises carry `Error` with the server's `error.message`.

- [ ] **Step 1: Failing test** (`client.test.ts`)
```ts
import { expect, test } from "bun:test";
import { RpcClient, type SocketLike } from "./client";

function fakeSocket() {
  const sent: string[] = [];
  const s: SocketLike & { sent: string[]; receive: (m: unknown) => void } = {
    sent, send: (d) => sent.push(d), onmessage: null,
    receive: (m) => s.onmessage?.(JSON.stringify(m)),
  };
  return s;
}

test("resolves matching response", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  const p = client.request<{ content: string }>("fs/read", { path: "a" });
  const req = JSON.parse(sock.sent[0]!);
  sock.receive({ jsonrpc: "2.0", id: req.id, result: { content: "hi" } });
  expect((await p).content).toBe("hi");
});

test("rejects on error response", async () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  const p = client.request("fs/read", { path: "../etc" });
  const req = JSON.parse(sock.sent[0]!);
  sock.receive({ jsonrpc: "2.0", id: req.id, error: { code: 1, message: "outside workspace" } });
  await expect(p).rejects.toThrow("outside workspace");
});

test("dispatches notifications", () => {
  const sock = fakeSocket();
  const client = new RpcClient(sock);
  const seen: unknown[] = [];
  client.onNotification((m, p) => seen.push([m, p]));
  sock.receive({ jsonrpc: "2.0", method: "fs/changed", params: { path: "a" } });
  expect(seen).toEqual([["fs/changed", { path: "a" }]]);
});
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** (`client.ts`)
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

  constructor(private socket: SocketLike) {
    socket.onmessage = (raw) => {
      const msg = parseMessage(raw);
      if ("id" in msg && ("result" in msg || "error" in msg)) {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
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

  onNotification(handler: (method: string, params: unknown) => void) { this.#notify = handler; }
}
```

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(protocol): isomorphic rpc client"`

---

### Task 4: Daemon RpcServer with token-authenticated WebSocket

**Files:**
- Create: `packages/daemon/src/rpc.ts`, `packages/daemon/src/server.ts`
- Test: `packages/daemon/src/server.test.ts`

**Interfaces:**
- Consumes: envelope types (Task 2).
- Produces:
  - `class RpcServer { register<P, R>(method: string, schema: z.ZodType<P>, handler: (params: P) => Promise<R>): void; async dispatch(raw: string): Promise<string | null>; }` (returns serialized response, null for notifications)
  - `createDaemon(opts: { root: string; port?: number; token?: string; webDist?: string }): { port: number; token: string; broadcast(method: string, params: unknown): void; stop(): void }`
  - WS endpoint: `ws://127.0.0.1:<port>/rpc?token=<token>`; wrong token => close 4001.

- [ ] **Step 1: Failing test** (`server.test.ts`)
```ts
import { expect, test } from "bun:test";
import { z } from "zod";
import { createDaemon } from "./server";

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${token}`);
    ws.onopen = () => resolve(ws);
    ws.onclose = (e) => reject(new Error(String(e.code)));
  });
}

test("rejects bad token with 4001", async () => {
  const d = createDaemon({ root: "/tmp" });
  await expect(connect(d.port, "wrong")).rejects.toThrow("4001");
  d.stop();
});

test("dispatches a registered method", async () => {
  const d = createDaemon({ root: "/tmp" });
  d.rpc.register("echo", z.object({ v: z.string() }), async (p) => ({ v: p.v }));
  const ws = await connect(d.port, d.token);
  const reply = new Promise<string>((r) => (ws.onmessage = (e) => r(String(e.data))));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { v: "x" } }));
  expect(JSON.parse(await reply)).toEqual({ jsonrpc: "2.0", id: 1, result: { v: "x" } });
  ws.close(); d.stop();
});

test("unknown method and bad params return errors", async () => {
  const d = createDaemon({ root: "/tmp" });
  d.rpc.register("echo", z.object({ v: z.string() }), async (p) => p);
  const ws = await connect(d.port, d.token);
  const replies: string[] = [];
  const two = new Promise<void>((r) => (ws.onmessage = (e) => { replies.push(String(e.data)); if (replies.length === 2) r(); }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo", params: { v: 7 } }));
  await two;
  expect(JSON.parse(replies[0]!).error.code).toBe(-32601);
  expect(JSON.parse(replies[1]!).error.code).toBe(-32602);
  ws.close(); d.stop();
});
```
Expose `rpc` on the returned daemon handle (add to Produces: `d.rpc: RpcServer`).

- [ ] **Step 2: Run** `bun test packages/daemon`: FAIL.
- [ ] **Step 3: Implement**

`rpc.ts`:
```ts
import { z } from "zod";
import { parseMessage, ProtocolError } from "@zero/protocol";

type Handler = { schema: z.ZodType<unknown>; fn: (params: unknown) => Promise<unknown> };

export class RpcServer {
  #methods = new Map<string, Handler>();

  register<P, R>(method: string, schema: z.ZodType<P>, fn: (params: P) => Promise<R>) {
    this.#methods.set(method, { schema, fn: fn as Handler["fn"] });
  }

  async dispatch(raw: string): Promise<string | null> {
    let id: number | null = null;
    try {
      const msg = parseMessage(raw);
      if (!("method" in msg)) return null;
      if (!("id" in msg)) return null; // client notifications: none yet
      id = msg.id;
      const handler = this.#methods.get(msg.method);
      if (!handler) return respondError(id, -32601, `unknown method ${msg.method}`);
      const params = handler.schema.safeParse(msg.params);
      if (!params.success) return respondError(id, -32602, "invalid params");
      const result = await handler.fn(params.data);
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

`server.ts`:
```ts
import { randomBytes } from "node:crypto";
import { RpcServer } from "./rpc";

export interface DaemonOptions { root: string; port?: number; token?: string; webDist?: string }

export function createDaemon(opts: DaemonOptions) {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const rpc = new RpcServer();
  const sockets = new Set<Bun.ServerWebSocket<unknown>>();

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
        return file.exists().then((ok) =>
          ok ? new Response(file) : new Response(Bun.file(opts.webDist + "/index.html")));
      }
      return new Response("zero daemon", { status: 200 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      async message(ws, raw) {
        const reply = await rpc.dispatch(String(raw));
        if (reply) ws.send(reply);
      },
    },
  });

  return {
    rpc, token, port: server.port,
    broadcast(method: string, params: unknown) {
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
      for (const ws of sockets) ws.send(msg);
    },
    stop() { server.stop(true); },
  };
}
```
Note: Bun upgrade path closes unauthorized WS during handshake; browsers surface it as close. To emit close code 4001 for an accepted-then-bad connection is not needed; the test asserts the connection fails (update test expectation to accept either close code 1006 or 4001: `rejects.toThrow(/4001|1006/)`).

- [ ] **Step 4: Run**: PASS. Add `@zero/protocol` and `zod` as deps of daemon; `bun install` if needed.
- [ ] **Step 5: Commit** `git commit -am "feat(daemon): token-authenticated websocket rpc server"`

---

### Task 5: Workspace service

**Files:**
- Create: `packages/daemon/src/workspace.ts`
- Test: `packages/daemon/src/workspace.test.ts`

**Interfaces:**
- Consumes: `TreeEntry` (Task 2).
- Produces:
  - `class PathOutsideWorkspaceError extends Error`
  - `class Workspace { constructor(root: string); read(rel: string): Promise<string>; write(rel: string, content: string): Promise<void>; tree(): Promise<TreeEntry[]>; watch(onChange: (relPath: string) => void): () => void }`
  - `tree()` skips `.git`, honors `.gitignore` via the `ignore` package, returns sorted relative paths.

- [ ] **Step 1: Failing test** (`workspace.test.ts`)
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, PathOutsideWorkspaceError } from "./workspace";

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "junk.js"), "x");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  return root;
}

test("read and write round-trip", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("b.ts", "hi");
  expect(await ws.read("b.ts")).toBe("hi");
});

test("blocks path traversal", async () => {
  const ws = new Workspace(makeProject());
  await expect(ws.read("../../etc/passwd")).rejects.toThrow(PathOutsideWorkspaceError);
  await expect(ws.write("/etc/x", "no")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("tree honors gitignore and skips .git", async () => {
  const ws = new Workspace(makeProject());
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths).toContain("a.ts");
  expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
  expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
});

test("watch reports changes", async () => {
  const ws = new Workspace(makeProject());
  const changed = new Promise<string>((r) => ws.watch(r));
  await ws.write("a.ts", "export const a = 2;\n");
  expect(await changed).toBe("a.ts");
});
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** (`workspace.ts`)
```ts
import { promises as fs, watch as fsWatch } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { TreeEntry } from "@zero/protocol";

export class PathOutsideWorkspaceError extends Error {}

export class Workspace {
  #root: string;
  constructor(root: string) { this.#root = resolve(root); }

  #resolve(rel: string): string {
    const abs = resolve(this.#root, rel);
    if (abs !== this.#root && !abs.startsWith(this.#root + sep))
      throw new PathOutsideWorkspaceError(rel);
    return abs;
  }

  async read(rel: string): Promise<string> {
    return fs.readFile(this.#resolve(rel), "utf8");
  }

  async write(rel: string, content: string): Promise<void> {
    await fs.writeFile(this.#resolve(rel), content, "utf8");
  }

  async #ignorer(): Promise<Ignore> {
    const ig = ignore().add([".git"]);
    try { ig.add(await fs.readFile(join(this.#root, ".gitignore"), "utf8")); } catch {}
    return ig;
  }

  async tree(): Promise<TreeEntry[]> {
    const ig = await this.#ignorer();
    const out: TreeEntry[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = relative(this.#root, join(dir, entry.name));
        if (ig.ignores(entry.isDirectory() ? rel + "/" : rel)) continue;
        out.push({ path: rel, kind: entry.isDirectory() ? "dir" : "file" });
        if (entry.isDirectory()) await walk(join(dir, entry.name));
      }
    };
    await walk(this.#root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  watch(onChange: (relPath: string) => void): () => void {
    const watcher = fsWatch(this.#root, { recursive: true }, (_event, filename) => {
      if (filename) onChange(String(filename));
    });
    return () => watcher.close();
  }
}
```
Add `ignore` (`"^5.3.0"`) to daemon deps.

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(daemon): workspace service with traversal guard and gitignore"`

---

### Task 6: Wire fs methods, watcher broadcast, CLI entry

**Files:**
- Create: `packages/daemon/src/main.ts`, `packages/daemon/bin/zero.ts`
- Modify: `packages/daemon/src/server.ts` (nothing structural; used as-is)
- Test: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Consumes: `createDaemon` (Task 4), `Workspace` (Task 5), fs types (Task 2).
- Produces:
  - `startZero(opts: { root: string; port?: number; token?: string; webDist?: string })` returning the daemon handle with methods registered: `fs/read`, `fs/write`, `fs/tree`; file changes broadcast as `fs/changed {path}`.
  - CLI: `bun packages/daemon/bin/zero.ts [path]` prints `zero ready: http://127.0.0.1:<port>/?token=<token>`.

- [ ] **Step 1: Failing test** (`main.test.ts`)
```ts
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
  const d = startZero({ root });
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
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement**

`main.ts`:
```ts
import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { Workspace } from "./workspace";

export function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);

  daemon.rpc.register("fs/read", z.object({ path: z.string() }),
    async (p) => ({ content: await ws.read(p.path) }));
  daemon.rpc.register("fs/write", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await ws.write(p.path, p.content); return {}; });
  daemon.rpc.register("fs/tree", z.object({}).optional().transform(() => ({})),
    async () => ({ entries: await ws.tree() }));

  const unwatch = ws.watch((path) => daemon.broadcast("fs/changed", { path }));
  const stop = daemon.stop;
  return { ...daemon, stop: () => { unwatch(); stop(); } };
}
```

`bin/zero.ts`:
```ts
import { resolve } from "node:path";
import { startZero } from "../src/main";

const root = resolve(process.argv[2] ?? ".");
const webDist = new URL("../../web/dist", import.meta.url).pathname;
const d = startZero({ root, port: 4820, webDist });
console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
```

- [ ] **Step 4: Run** `bun test packages/daemon`: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(daemon): fs rpc methods, change broadcast, cli entry"`

---

### Task 7: Web shell: file tree, CodeMirror editing, save

**Files:**
- Create: `packages/web/package.json`, `packages/web/vite.config.ts`, `packages/web/index.html`
- Create: `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/connection.ts`, `packages/web/src/FileTree.tsx`, `packages/web/src/Editor.tsx`
- Test: manual verification (UI); logic stays out of components where possible.

**Interfaces:**
- Consumes: `RpcClient`, `SocketLike`, `TreeEntry` (Tasks 2-3); daemon from Task 6.
- Produces: `connect(): Promise<RpcClient>` reading `?token=` and host from `location` (dev override via `VITE_ZERO_URL`, `VITE_ZERO_TOKEN`); `<App/>` with file tree, editor, Cmd/Ctrl+S save.

- [ ] **Step 1: Scaffold**

`packages/web/package.json`:
```json
{
  "name": "@zero/web", "type": "module", "private": true,
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "@zero/protocol": "workspace:*", "@zero/core": "workspace:*",
    "react": "^18.3.0", "react-dom": "^18.3.0",
    "codemirror": "^6.0.1", "@codemirror/state": "^6.4.0",
    "@codemirror/view": "^6.28.0", "@codemirror/lang-javascript": "^6.2.0"
  },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0", "typescript": "^5.5.0" }
}
```
`vite.config.ts`: standard react plugin. `index.html`: root div + module script to `src/main.tsx`.

- [ ] **Step 2: Connection** (`connection.ts`)
```ts
import { RpcClient, type SocketLike } from "@zero/protocol";

export function connect(): Promise<RpcClient> {
  const params = new URLSearchParams(location.search);
  const base = import.meta.env.VITE_ZERO_URL ?? `ws://${location.host}`;
  const token = params.get("token") ?? import.meta.env.VITE_ZERO_TOKEN ?? "";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/rpc?token=${token}`);
    const socket: SocketLike = { send: (d) => ws.send(d), onmessage: null };
    ws.onmessage = (e) => socket.onmessage?.(String(e.data));
    ws.onopen = () => resolve(new RpcClient(socket));
    ws.onerror = () => reject(new Error("daemon unreachable"));
  });
}
```

- [ ] **Step 3: Components**

`FileTree.tsx`: fetch `fs/tree` on mount, render nested list from flat sorted paths (indent by `path.split("/").length`), `onOpen(path)` for files.

`Editor.tsx`:
```tsx
import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";

export function Editor(props: { content: string; onSave: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  useEffect(() => {
    view.current?.destroy();
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.content,
        extensions: [basicSetup, javascript({ typescript: true }),
          keymap.of([{ key: "Mod-s", preventDefault: true,
            run: (v) => { props.onSave(v.state.doc.toString()); return true; } }])],
      }),
    });
    return () => view.current?.destroy();
  }, [props.content]);
  return <div ref={host} style={{ height: "100%" }} />;
}
```

`App.tsx`: holds `client`, `openPath`, `content`; opening a file calls `fs/read`; `onSave` calls `fs/write`; subscribes to `fs/changed` and re-reads the open file if it changed externally. Two-pane flex layout, tree left (240px), editor right.

- [ ] **Step 4: Verify manually**

Run: `bun packages/daemon/bin/zero.ts . &` then `cd packages/web && bunx vite --open "http://localhost:5173/?token=<printed token>"` with `VITE_ZERO_URL=ws://127.0.0.1:4820`.
Expected: tree renders this repo, open a file, edit, Cmd+S, `git diff` shows the change. Also `bunx vite build` succeeds and `http://127.0.0.1:4820/?token=...` serves the built app.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): file tree, codemirror editor, save over rpc"`

**This completes M0.**

---

### Task 8: @zero/core types, token estimate, FIM prompt builder

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/tokens.ts`, `packages/core/src/prompt.ts`
- Modify: `packages/core/src/index.ts` (re-export all)
- Test: `packages/core/src/prompt.test.ts`

**Interfaces:**
- Produces (exact, used by every later task):
```ts
export interface ModelCapabilities { id: string; contextWindowTokens: number; supportsFim: boolean }
export interface CompletionRequest { path: string; prefix: string; suffix: string; language?: string }
export interface ModelProvider {
  id: string;
  available(): Promise<boolean>;
  capabilities(): ModelCapabilities;
  complete(prompt: string, signal: AbortSignal): AsyncIterable<string>;
}
export interface ContextChunk { source: string; text: string; score: number; tokenCost: number }
export interface ContextProvider {
  name: string;
  gather(req: CompletionRequest): Promise<ContextChunk[]>;
}
export function estimateTokens(text: string): number; // Math.ceil(len / 4)
export function buildFimPrompt(req: CompletionRequest, chunks: ContextChunk[], caps: ModelCapabilities): string;
```
- `buildFimPrompt` budget: `caps.contextWindowTokens - 256` (reserved for output). Order: chunks (highest score first, dropped when over budget), then `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>` when `supportsFim`, else instruction template `"Continue the code at <CURSOR>. Output only code.\n{prefix}<CURSOR>{suffix}"` with prefix/suffix trimmed from the far ends to fit (keep the text nearest the cursor).

- [ ] **Step 1: Failing test** (`prompt.test.ts`)
```ts
import { expect, test } from "bun:test";
import { buildFimPrompt, estimateTokens } from "./index";

const caps = { id: "fake", contextWindowTokens: 100, supportsFim: true };
const req = { path: "a.ts", prefix: "const a = ", suffix: ";\n" };

test("estimateTokens is ceil(chars/4)", () => {
  expect(estimateTokens("abcde")).toBe(2);
});

test("includes high-score chunks and fim markers", () => {
  const p = buildFimPrompt(req, [
    { source: "buffer", text: "function helper() {}", score: 0.9, tokenCost: 5 },
  ], caps);
  expect(p).toContain("function helper() {}");
  expect(p).toContain("<|fim_prefix|>const a = <|fim_suffix|>;\n<|fim_middle|>");
});

test("drops chunks over budget, highest score wins", () => {
  const big = "x".repeat(200); // 50 tokens
  const p = buildFimPrompt(req, [
    { source: "low", text: big + "LOW", score: 0.1, tokenCost: 51 },
    { source: "high", text: big + "HIGH", score: 0.9, tokenCost: 51 },
  ], caps);
  expect(p).toContain("HIGH");
  expect(p).not.toContain("LOW");
});

test("trims prefix from the left to fit tiny windows", () => {
  const tiny = { ...caps, contextWindowTokens: 70 };
  const longPrefix = "y".repeat(1000) + "NEAR_CURSOR";
  const p = buildFimPrompt({ ...req, prefix: longPrefix }, [], tiny);
  expect(p).toContain("NEAR_CURSOR");
  expect(p.length).toBeLessThan(1000);
});
```

- [ ] **Step 2: Run** `bun test packages/core`: FAIL.
- [ ] **Step 3: Implement**

`tokens.ts`: `export const estimateTokens = (t: string) => Math.ceil(t.length / 4);`

`prompt.ts`:
```ts
import type { CompletionRequest, ContextChunk, ModelCapabilities } from "./types";
import { estimateTokens } from "./tokens";

export function buildFimPrompt(req: CompletionRequest, chunks: ContextChunk[], caps: ModelCapabilities): string {
  const budget = caps.contextWindowTokens - 256;
  const body = caps.supportsFim
    ? (p: string, s: string) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`
    : (p: string, s: string) => `Continue the code at <CURSOR>. Output only code.\n${p}<CURSOR>${s}`;

  // Reserve up to half the budget for context, rest for prefix/suffix.
  const picked: string[] = [];
  let used = 0;
  const contextBudget = Math.floor(budget / 2);
  for (const c of [...chunks].sort((a, b) => b.score - a.score)) {
    if (used + c.tokenCost > contextBudget) continue;
    picked.push(c.text); used += c.tokenCost;
  }

  let { prefix, suffix } = req;
  const fit = () => estimateTokens(body(prefix, suffix)) + used <= budget;
  while (!fit() && (prefix.length > 0 || suffix.length > 0)) {
    if (prefix.length >= suffix.length) prefix = prefix.slice(100); // trim far-from-cursor left edge
    else suffix = suffix.slice(0, -100); // trim far-from-cursor right edge
  }
  const context = picked.length ? picked.join("\n") + "\n" : "";
  return context + body(prefix, suffix);
}
```
`types.ts` exactly as in Produces. `index.ts` re-exports types, tokens, prompt.

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): provider types, token estimate, fim prompt builder"`

---

### Task 9: Context gathering with budget + BufferContext

**Files:**
- Create: `packages/core/src/context.ts`, `packages/core/src/bufferContext.ts`
- Test: `packages/core/src/context.test.ts`

**Interfaces:**
- Consumes: `ContextProvider`, `ContextChunk`, `CompletionRequest`, `estimateTokens` (Task 8).
- Produces:
  - `gatherContext(providers: ContextProvider[], req: CompletionRequest, budgetMs: number, now?: () => number): Promise<ContextChunk[]>`: runs providers in parallel, drops any that miss the budget (their late results are ignored; errors are swallowed).
  - `class BufferContext implements ContextProvider { name = "buffer"; setBuffers(buffers: { path: string; content: string }[]): void; gather(req): Promise<ContextChunk[]> }`: returns one chunk per *other* open buffer, `score: 0.5`, text truncated to first 2000 chars, `tokenCost` from `estimateTokens`.

- [ ] **Step 1: Failing test** (`context.test.ts`)
```ts
import { expect, test } from "bun:test";
import { gatherContext } from "./context";
import { BufferContext } from "./bufferContext";
import type { ContextProvider } from "./types";

const req = { path: "a.ts", prefix: "", suffix: "" };
const chunk = (source: string) => ({ source, text: source, score: 1, tokenCost: 1 });

function provider(name: string, delayMs: number): ContextProvider {
  return { name, gather: () => new Promise((r) => setTimeout(() => r([chunk(name)]), delayMs)) };
}

test("fast providers included, slow dropped, errors swallowed", async () => {
  const boom: ContextProvider = { name: "boom", gather: () => Promise.reject(new Error("x")) };
  const chunks = await gatherContext([provider("fast", 5), provider("slow", 200), boom], req, 50);
  expect(chunks.map((c) => c.source)).toEqual(["fast"]);
});

test("BufferContext excludes the current file and truncates", async () => {
  const buf = new BufferContext();
  buf.setBuffers([
    { path: "a.ts", content: "current" },
    { path: "b.ts", content: "z".repeat(5000) },
  ]);
  const chunks = await buf.gather(req);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.source).toBe("buffer:b.ts");
  expect(chunks[0]!.text.length).toBe(2000);
});
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement**

`context.ts`:
```ts
import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";

export async function gatherContext(
  providers: ContextProvider[], req: CompletionRequest, budgetMs: number,
): Promise<ContextChunk[]> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), budgetMs));
  const results = await Promise.all(providers.map((p) =>
    Promise.race([p.gather(req).catch(() => null), timeout])));
  return results.flatMap((r) => r ?? []);
}
```

`bufferContext.ts`:
```ts
import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";
import { estimateTokens } from "./tokens";

export class BufferContext implements ContextProvider {
  name = "buffer";
  #buffers: { path: string; content: string }[] = [];
  setBuffers(buffers: { path: string; content: string }[]) { this.#buffers = buffers; }
  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    return this.#buffers
      .filter((b) => b.path !== req.path)
      .map((b) => {
        const text = b.content.slice(0, 2000);
        return { source: `buffer:${b.path}`, text, score: 0.5, tokenCost: estimateTokens(text) };
      });
  }
}
```
Re-export both from `index.ts`.

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): budgeted context gathering and buffer provider"`

---

### Task 10: CompletionEngine + scheduler

**Files:**
- Create: `packages/core/src/engine.ts`, `packages/core/src/scheduler.ts`
- Test: `packages/core/src/engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 8-9.
- Produces:
  - `interface EngineStatus { activeModel: string | null; reason: string | null }`
  - `class CompletionEngine { constructor(opts: { providers: ModelProvider[]; context: ContextProvider[]; contextBudgetMs?: number }); status(): EngineStatus; onStatusChange(fn: (s: EngineStatus) => void): void; complete(req: CompletionRequest, signal: AbortSignal): Promise<string | null> }`
    - Picks the first provider whose `available()` resolves true (checked per call, cached 30s); sets status to that provider's id, or `{activeModel: null, reason: "no model available"}`.
    - Gathers context (50ms default), builds prompt via `buildFimPrompt`, concatenates the stream; returns `null` if aborted or no provider.
  - `class CompletionScheduler { constructor(run: (signal: AbortSignal) => Promise<void>, debounceMs?: number); trigger(): void; cancel(): void }`: 150ms default debounce, aborts any in-flight run on new trigger (single-flight).

- [ ] **Step 1: Failing test** (`engine.test.ts`)
```ts
import { expect, test } from "bun:test";
import { CompletionEngine } from "./engine";
import { CompletionScheduler } from "./scheduler";
import type { ModelProvider } from "./types";

function fakeProvider(id: string, avail: boolean, output = "done()"): ModelProvider {
  return {
    id, available: async () => avail,
    capabilities: () => ({ id, contextWindowTokens: 1000, supportsFim: true }),
    async *complete(_prompt, signal) {
      for (const ch of output) { if (signal.aborted) return; yield ch; }
    },
  };
}
const req = { path: "a.ts", prefix: "const a = ", suffix: "" };

test("uses first available provider and streams result", async () => {
  const engine = new CompletionEngine({
    providers: [fakeProvider("nano", false), fakeProvider("ollama", true)],
    context: [],
  });
  const out = await engine.complete(req, new AbortController().signal);
  expect(out).toBe("done()");
  expect(engine.status()).toEqual({ activeModel: "ollama", reason: null });
});

test("returns null and sets reason when nothing available", async () => {
  const engine = new CompletionEngine({ providers: [fakeProvider("nano", false)], context: [] });
  expect(await engine.complete(req, new AbortController().signal)).toBeNull();
  expect(engine.status()).toEqual({ activeModel: null, reason: "no model available" });
});

test("abort mid-stream returns null", async () => {
  const engine = new CompletionEngine({ providers: [fakeProvider("m", true)], context: [] });
  const ctl = new AbortController();
  ctl.abort();
  expect(await engine.complete(req, ctl.signal)).toBeNull();
});

test("scheduler debounces and aborts previous run", async () => {
  const signals: AbortSignal[] = [];
  let runs = 0;
  const sched = new CompletionScheduler(async (signal) => { runs++; signals.push(signal); }, 10);
  sched.trigger(); sched.trigger(); sched.trigger();
  await new Promise((r) => setTimeout(r, 30));
  expect(runs).toBe(1);
  sched.trigger();
  await new Promise((r) => setTimeout(r, 30));
  expect(runs).toBe(2);
  expect(signals[0]!.aborted).toBe(true);
});
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement**

`engine.ts`:
```ts
import type { CompletionRequest, ContextProvider, ModelProvider } from "./types";
import { gatherContext } from "./context";
import { buildFimPrompt } from "./prompt";

export interface EngineStatus { activeModel: string | null; reason: string | null }

export class CompletionEngine {
  #providers: ModelProvider[];
  #context: ContextProvider[];
  #budgetMs: number;
  #status: EngineStatus = { activeModel: null, reason: null };
  #listeners = new Set<(s: EngineStatus) => void>();
  #availCache = new Map<string, { ok: boolean; at: number }>();

  constructor(opts: { providers: ModelProvider[]; context: ContextProvider[]; contextBudgetMs?: number }) {
    this.#providers = opts.providers;
    this.#context = opts.context;
    this.#budgetMs = opts.contextBudgetMs ?? 50;
  }

  status() { return this.#status; }
  onStatusChange(fn: (s: EngineStatus) => void) { this.#listeners.add(fn); }
  #setStatus(s: EngineStatus) {
    this.#status = s;
    for (const fn of this.#listeners) fn(s);
  }

  async #pick(): Promise<ModelProvider | null> {
    for (const p of this.#providers) {
      const cached = this.#availCache.get(p.id);
      const ok = cached && Date.now() - cached.at < 30_000
        ? cached.ok : await p.available().catch(() => false);
      this.#availCache.set(p.id, { ok, at: Date.now() });
      if (ok) return p;
    }
    return null;
  }

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<string | null> {
    const provider = await this.#pick();
    if (!provider) { this.#setStatus({ activeModel: null, reason: "no model available" }); return null; }
    this.#setStatus({ activeModel: provider.id, reason: null });
    if (signal.aborted) return null;
    const chunks = await gatherContext(this.#context, req, this.#budgetMs);
    const prompt = buildFimPrompt(req, chunks, provider.capabilities());
    let out = "";
    try {
      for await (const piece of provider.complete(prompt, signal)) {
        if (signal.aborted) return null;
        out += piece;
      }
    } catch { return null; }
    return signal.aborted ? null : out || null;
  }
}
```

`scheduler.ts`:
```ts
export class CompletionScheduler {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #abort: AbortController | null = null;
  constructor(private run: (signal: AbortSignal) => Promise<void>, private debounceMs = 150) {}

  trigger() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#abort?.abort();
    this.#timer = setTimeout(() => {
      this.#abort = new AbortController();
      void this.run(this.#abort.signal);
    }, this.debounceMs);
  }

  cancel() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#abort?.abort();
  }
}
```
Re-export from `index.ts`.

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): completion engine with fallback and single-flight scheduler"`

---

### Task 11: OpenAICompatProvider (Ollama et al.)

**Files:**
- Create: `packages/core/src/providers/openaiCompat.ts`
- Test: `packages/core/src/providers/openaiCompat.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ModelCapabilities` (Task 8).
- Produces: `class OpenAICompatProvider implements ModelProvider { constructor(opts: { baseUrl: string; model: string; contextWindowTokens?: number; fetchImpl?: typeof fetch }) }`
  - `id` = `"openai:" + model`. `available()` = GET `{baseUrl}/models` ok within 1s. `capabilities()`: `supportsFim: true`, window default 8192.
  - `complete()` POSTs `{baseUrl}/completions` with `{ model, prompt, stream: true, max_tokens: 256 }`, parses SSE lines `data: {...choices:[{text}]}` until `data: [DONE]`, yields each `text`. Passes `signal` to fetch.

- [ ] **Step 1: Failing test** (`openaiCompat.test.ts`)
```ts
import { expect, test } from "bun:test";
import { OpenAICompatProvider } from "./openaiCompat";

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
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** (`openaiCompat.ts`)
```ts
import type { ModelCapabilities, ModelProvider } from "../types";

export class OpenAICompatProvider implements ModelProvider {
  id: string;
  #opts: { baseUrl: string; model: string; contextWindowTokens: number; fetchImpl: typeof fetch };

  constructor(opts: { baseUrl: string; model: string; contextWindowTokens?: number; fetchImpl?: typeof fetch }) {
    this.id = `openai:${opts.model}`;
    this.#opts = { contextWindowTokens: 8192, fetchImpl: fetch, ...opts };
  }

  capabilities(): ModelCapabilities {
    return { id: this.id, contextWindowTokens: this.#opts.contextWindowTokens, supportsFim: true };
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/models`,
        { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch { return false; }
  }

  async *complete(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/completions`, {
      method: "POST", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.#opts.model, prompt, stream: true, max_tokens: 256 }),
    });
    if (!res.ok || !res.body) throw new Error(`completion failed: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        const text = JSON.parse(payload).choices?.[0]?.text;
        if (text) yield text;
      }
    }
  }
}
```
Re-export from `index.ts`.

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): openai-compatible streaming provider"`

---

### Task 12: ChromeNanoProvider + capability probe

**Files:**
- Create: `packages/core/src/providers/chromeNano.ts`
- Test: `packages/core/src/providers/chromeNano.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` (Task 8).
- Produces:
  - `interface NanoApi { availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">; create(opts?: { monitor?: (m: EventTarget) => void }): Promise<NanoSession> }`
  - `interface NanoSession { promptStreaming(input: string, opts?: { signal?: AbortSignal }): AsyncIterable<string>; destroy(): void; inputQuota?: number }`
  - `class ChromeNanoProvider implements ModelProvider { constructor(api: NanoApi | undefined) }`: `id: "chrome-nano"`; `available()` true only when api exists and availability is `"available"`; `capabilities()`: `contextWindowTokens: min(inputQuota ?? 6144, 6144)`, `supportsFim: false`; `complete()` creates (and caches) a session and yields streamed chunks.
  - `probeNano(api: NanoApi | undefined): Promise<"ready" | "downloadable" | "unavailable">` for the UI download flow.
  - The web layer passes `(globalThis as { LanguageModel?: NanoApi }).LanguageModel`; core never touches globals.

- [ ] **Step 1: Failing test** (`chromeNano.test.ts`)
```ts
import { expect, test } from "bun:test";
import { ChromeNanoProvider, probeNano, type NanoApi } from "./chromeNano";

function fakeApi(state: "available" | "downloadable" | "unavailable"): NanoApi {
  return {
    availability: async () => state,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string) { yield "echo:"; yield input.slice(0, 4); },
      destroy() {},
    }),
  };
}

test("probe maps states", async () => {
  expect(await probeNano(undefined)).toBe("unavailable");
  expect(await probeNano(fakeApi("downloadable"))).toBe("downloadable");
  expect(await probeNano(fakeApi("available"))).toBe("ready");
});

test("available only when ready", async () => {
  expect(await new ChromeNanoProvider(undefined).available()).toBe(false);
  expect(await new ChromeNanoProvider(fakeApi("downloadable")).available()).toBe(false);
  expect(await new ChromeNanoProvider(fakeApi("available")).available()).toBe(true);
});

test("streams from a session", async () => {
  const p = new ChromeNanoProvider(fakeApi("available"));
  let out = "";
  for await (const t of p.complete("test", new AbortController().signal)) out += t;
  expect(out).toBe("echo:test");
});
```

- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** (`chromeNano.ts`)
```ts
import type { ModelCapabilities, ModelProvider } from "../types";

export interface NanoSession {
  promptStreaming(input: string, opts?: { signal?: AbortSignal }): AsyncIterable<string>;
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

export class ChromeNanoProvider implements ModelProvider {
  id = "chrome-nano";
  #session: NanoSession | null = null;
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
}
```
Re-export from `index.ts`.

- [ ] **Step 4: Run**: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): chrome nano provider and capability probe"`

---

### Task 13: Ghost text UX, status pill, settings, E2E verification

**Files:**
- Create: `packages/web/src/suggestionState.ts` (pure, no DOM: `suggestionField`, `setSuggestion`, `clearSuggestion`, `acceptWord`), `packages/web/src/ghostText.ts` (imports from suggestionState; adds decorations/keymap/trigger), `packages/web/src/completionSetup.ts`, `packages/web/src/StatusPill.tsx`, `packages/web/src/Settings.tsx`
- Modify: `packages/web/src/Editor.tsx`, `packages/web/src/App.tsx`
- Test: `packages/web/src/suggestionState.test.ts` (pure state logic, bun test; must not import `@codemirror/view`, which needs a DOM) + manual E2E checklist.

**Interfaces:**
- Consumes: `CompletionEngine`, `CompletionScheduler`, `BufferContext`, `ChromeNanoProvider`, `probeNano`, `OpenAICompatProvider`, `EngineStatus` (Tasks 8-12).
- Produces: CodeMirror extension `ghostText(requestCompletion)` where `requestCompletion(state: {path, prefix, suffix}) => void`; effects `setSuggestion` / `clearSuggestion`; keybindings Tab (accept all), `Alt-ArrowRight` (accept word), Esc (dismiss).

- [ ] **Step 1: Failing test for suggestion state** (`suggestionState.test.ts`)
```ts
import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { suggestionField, setSuggestion, acceptWord } from "./suggestionState";

test("suggestion set, cleared on doc change", () => {
  let state = EditorState.create({ doc: "const a = ", extensions: [suggestionField] });
  state = state.update({ effects: setSuggestion.of("1 + 2;") }).state;
  expect(state.field(suggestionField)).toBe("1 + 2;");
  state = state.update({ changes: { from: 10, insert: "x" } }).state;
  expect(state.field(suggestionField)).toBeNull();
});

test("acceptWord splits off the first word", () => {
  expect(acceptWord("foo(bar) baz")).toEqual({ take: "foo(bar)", rest: " baz" });
  expect(acceptWord("  x")).toEqual({ take: "  x", rest: "" });
});
```

- [ ] **Step 2: Run** `bun test packages/web`: FAIL. (Add `@codemirror/state` types; bun runs this headless since state logic has no DOM.)

- [ ] **Step 3: Implement**

`suggestionState.ts` (no DOM imports):
```ts
import { StateField, StateEffect } from "@codemirror/state";

export const setSuggestion = StateEffect.define<string>();
export const clearSuggestion = StateEffect.define<null>();

export const suggestionField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
      if (e.is(clearSuggestion)) return null;
    }
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

export function acceptWord(suggestion: string): { take: string; rest: string } {
  const m = suggestion.match(/^\s*\S+/);
  const take = m ? m[0] : suggestion;
  return { take, rest: suggestion.slice(take.length) };
}
```

`ghostText.ts`:
```ts
import { Prec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import { suggestionField, setSuggestion, clearSuggestion, acceptWord } from "./suggestionState";
export { suggestionField, setSuggestion, clearSuggestion, acceptWord };

class GhostWidget extends WidgetType {
  constructor(private text: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.style.opacity = "0.45";
    span.textContent = this.text;
    return span;
  }
}

const ghostDecoration = EditorView.decorations.compute(
  [suggestionField, "selection"],
  (state): DecorationSet => {
    const text = state.field(suggestionField);
    if (!text) return Decoration.none;
    return Decoration.set([
      Decoration.widget({ widget: new GhostWidget(text), side: 1 })
        .range(state.selection.main.head),
    ]);
  });

function insert(view: EditorView, text: string, remainder: string | null) {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    effects: remainder ? setSuggestion.of(remainder) : clearSuggestion.of(null),
  });
}

const ghostKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: (v) => { const s = v.state.field(suggestionField); if (!s) return false; insert(v, s, null); return true; } },
  { key: "Alt-ArrowRight", run: (v) => { const s = v.state.field(suggestionField); if (!s) return false; const { take, rest } = acceptWord(s); insert(v, take, rest || null); return true; } },
  { key: "Escape", run: (v) => { if (!v.state.field(suggestionField)) return false; v.dispatch({ effects: clearSuggestion.of(null) }); return true; } },
]));

export function ghostText(requestCompletion: (s: { prefix: string; suffix: string }) => void) {
  const trigger = EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const pos = u.state.selection.main.head;
    requestCompletion({
      prefix: u.state.doc.sliceString(0, pos),
      suffix: u.state.doc.sliceString(pos),
    });
  });
  return [suggestionField, ghostDecoration, ghostKeymap, trigger];
}
```

- [ ] **Step 4: Wire the engine** (`completionSetup.ts`)
```ts
import { CompletionEngine, CompletionScheduler, BufferContext,
  ChromeNanoProvider, OpenAICompatProvider, type NanoApi } from "@zero/core";
import type { EditorView } from "@codemirror/view";
import { setSuggestion } from "./ghostText";

export function createCompletion(getView: () => EditorView | undefined, path: () => string) {
  const nanoApi = (globalThis as { LanguageModel?: NanoApi }).LanguageModel;
  const buffers = new BufferContext();
  const engine = new CompletionEngine({
    providers: [
      new ChromeNanoProvider(nanoApi),
      new OpenAICompatProvider({
        baseUrl: localStorage.getItem("zero.ollamaUrl") ?? "http://127.0.0.1:11434/v1",
        model: localStorage.getItem("zero.ollamaModel") ?? "qwen2.5-coder:1.5b",
      }),
    ],
    context: [buffers],
  });

  let latest = { prefix: "", suffix: "" };
  const scheduler = new CompletionScheduler(async (signal) => {
    const text = await engine.complete({ path: path(), ...latest }, signal);
    const view = getView();
    if (text && !signal.aborted && view) view.dispatch({ effects: setSuggestion.of(text) });
  });

  return {
    engine, buffers,
    request(s: { prefix: string; suffix: string }) { latest = s; scheduler.trigger(); },
  };
}
```
`StatusPill.tsx`: subscribes via `engine.onStatusChange`, renders `activeModel ?? "no model"` with a colored dot (green when a model is active, gray otherwise) and `reason` as tooltip. `Settings.tsx`: two inputs writing `zero.ollamaUrl` / `zero.ollamaModel` to localStorage. `Editor.tsx` adds `ghostText(completion.request)` to extensions; `App.tsx` mounts `createCompletion`, updates `buffers.setBuffers` on file open/edit, renders pill + settings.

- [ ] **Step 5: Run unit tests** `bun test`: all packages PASS.

- [ ] **Step 6: Manual E2E checklist**

1. `bun packages/daemon/bin/zero.ts <some project>` and open the printed URL in Chrome 138+ with Gemini Nano enabled. Type in a file; ghost text appears within ~1s; Tab accepts; Esc dismisses; Alt-Right accepts one word. Status pill shows `chrome-nano`.
2. In a Chrome profile without Nano but with Ollama running (`ollama serve`, `ollama pull qwen2.5-coder:1.5b`): pill shows `openai:qwen2.5-coder:1.5b`, completions work.
3. With neither: pill shows "no model", editing and saving still work (Global Constraint: editor never breaks).
4. Kill the daemon mid-session: reconnect banner behavior is deferred to M2, but the page must not lose the unsaved buffer (verify the buffer text is still in the editor).

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat(web): ghost text completions with nano/ollama fallback and status pill"`

**This completes M1: Zero is an offline copilot.**
