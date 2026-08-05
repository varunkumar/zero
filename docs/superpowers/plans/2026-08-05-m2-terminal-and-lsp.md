# M2 Terminal and LSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real terminal (PTY service + xterm.js, reattachable, multiple
tabs) and LSP-backed editor intelligence (diagnostics, hover, go-to-definition
for TypeScript and Python, `LspContext` feeding completions) to Zero.

**Architecture:** Bottom-up, protocol → daemon → core → web, matching the M0/M1
and M1.5 plans. `@zero/protocol` gains PTY and LSP message types (plain
interfaces, no Zod — matching the existing `Fs*`/`Settings*` style; daemon-side
`z.object(...)` schemas do the runtime validation as today). The daemon gets
two new services: `PtyService` (thin `node-pty` wrapper, keyed by
`sessionId`) and `LspService` (spawns one language server process per
language from a config-driven, settings-overridable registry, speaks LSP over
stdio via `vscode-jsonrpc`, re-exposes hover/definition/diagnostics/contextAt
over Zero RPC). Both stream events (`pty/output`, `lsp/diagnostics`, etc.)
through the daemon's existing `broadcast()` — there is no per-connection
subscription registry; every event carries a `sessionId` or `path` and
clients filter locally, per the approved design. `@zero/core` gets
`LspContext`, a `ContextProvider` matching `BufferContext`'s shape. `@zero/web`
gets a bottom dockview panel for tabbed terminals (xterm.js), diagnostics via
`@codemirror/lint`, a hover tooltip, go-to-definition, and a status-bar LSP
health slot.

**Tech Stack:** `node-pty` (PTY), `@xterm/xterm` + `@xterm/addon-fit`
(terminal UI), `vscode-jsonrpc` + `vscode-languageserver-protocol` (LSP client
transport/types), `typescript-language-server` + `typescript` +  `pyright`
(bundled default servers), `@codemirror/lint` (diagnostics UI). Bun test for
all new unit/integration tests — no new test infra.

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs (from `CLAUDE.md`). `LspContext` in `@zero/core` talks to the daemon only through an injected `{ request<R>(method, params?): Promise<R> }` interface — never a concrete transport.
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session token are rejected.
- The editor must stay fully usable when no model, PTY, or LSP server is available — degrade the failing subsystem only, never break editing. A missing/crashing language server must not stall typing, completions, or the terminal.
- Token estimate convention: `Math.ceil(chars / 4)` (`estimateTokens` in `packages/core/src/tokens.ts`) — `LspContext` reuses it, does not reimplement it.
- Completion budgets: 150ms keystroke debounce, 50ms context-gather budget, one completion request in flight at a time — `LspContext.gather()` runs inside the existing `gatherContext()` race in `packages/core/src/context.ts` and must not change that budget.
- New behavior needs tests alongside it (`*.test.ts` next to each module); `@zero/core` expects dense unit coverage with injected fakes, not real DOM/Node dependencies.
- Commit after each coherent unit of work; conventional-commit style messages.
- `RpcClient.onNotification` supports exactly **one** handler (it overwrites, does not fan out) — `packages/protocol/src/client.ts:35`. Only `Workbench.tsx` may call it; every module that needs `pty/output`, `pty/exit`, or `lsp/diagnostics` subscribes through the fan-out dispatcher `Workbench.tsx` already owns for `fs/changed` (extend the same `useEffect`, do not add a second `onNotification` call anywhere else).
- The daemon's `broadcast()` (`packages/daemon/src/server.ts:41`) sends to every connected socket; there is no per-connection subscription registry in M2 (an explicit scope decision — see design discussion). Every PTY/LSP event therefore carries a `sessionId` or `path` and clients filter client-side.
- No server-side terminal scrollback replay: PTY sessions survive a browser disconnect (the process keeps running daemon-side), but output produced while no browser was connected is not buffered or replayed on reattach — only new output from the moment of reattach forward. Out of scope per the design; buffering would require an unbounded or arbitrarily-capped daemon-side ring buffer per session, not part of this plan.
- LSP servers are configured through a data-driven, settings-overridable registry (`{ [key]: { command, args, languageIds } }`), not a full plugin host — the plugin host (manifests, hot-loadable packages, section 4.7 of the design doc) is explicitly M3 scope, not M2.
- Default servers (`typescript-language-server`, `pyright`) are bundled as `@zero/daemon` dependencies so they work with no user setup; a user can override or add entries via the `lsp.servers` setting (same `.zero/settings.json` / `settings/get` / `settings/set` mechanism `SettingsStore` already uses for `workbench`).
- Full-document sync only: the daemon does not attempt LSP incremental `textDocument/didChange` ranges. Every sync sends the whole buffer text. Simpler, correct, and the payloads involved (source files) are small enough that this is not a real cost.
- Out of scope for M2: multi-root workspaces, LSP `workspace/symbol`, rename, code actions, formatting, semantic tokens, and any language other than TypeScript/JavaScript and Python. Out of scope for the terminal: split terminal panes, terminal search, terminal themes distinct from the editor theme.

---

## Task 1: Protocol — PTY message types

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts` (create if it doesn't exist yet)

**Interfaces:**
- Produces: `PtyOpenParams { shell?: string; cols: number; rows: number }`, `PtyOpenResult { sessionId: string; shell: string }`, `PtyInputParams { sessionId: string; data: string }`, `PtyResizeParams { sessionId: string; cols: number; rows: number }`, `PtyCloseParams { sessionId: string }`, `PtySessionInfo { sessionId: string; shell: string }`, `PtyListResult { sessions: PtySessionInfo[] }`, `PtyOutputEvent { sessionId: string; data: string }`, `PtyExitEvent { sessionId: string; exitCode: number }`.

- [ ] **Step 1: Add the interfaces**

Append to `packages/protocol/src/messages.ts`:

```typescript
export interface PtyOpenParams { shell?: string; cols: number; rows: number }
export interface PtyOpenResult { sessionId: string; shell: string }
export interface PtyInputParams { sessionId: string; data: string }
export interface PtyResizeParams { sessionId: string; cols: number; rows: number }
export interface PtyCloseParams { sessionId: string }
export interface PtySessionInfo { sessionId: string; shell: string }
export interface PtyListResult { sessions: PtySessionInfo[] }
export interface PtyOutputEvent { sessionId: string; data: string }
export interface PtyExitEvent { sessionId: string; exitCode: number }
```

- [ ] **Step 2: Write a round-trip test**

Create `packages/protocol/src/messages.test.ts` (or append if the file already exists from an earlier milestone):

```typescript
import { expect, test } from "bun:test";
import type { PtyOpenParams, PtyOpenResult, PtyOutputEvent } from "./messages";

test("pty message shapes are plain JSON-serializable", () => {
  const open: PtyOpenParams = { cols: 80, rows: 24 };
  const result: PtyOpenResult = { sessionId: "abc", shell: "/bin/bash" };
  const output: PtyOutputEvent = { sessionId: "abc", data: "hello\n" };
  expect(JSON.parse(JSON.stringify(open))).toEqual(open);
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(JSON.parse(JSON.stringify(output))).toEqual(output);
});
```

- [ ] **Step 3: Run the test**

Run: `bun test packages/protocol/src/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add PTY RPC message types"
```

---

## Task 2: Protocol — LSP message types

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/messages.test.ts`

**Interfaces:**
- Produces: `LspPosition { line: number; character: number }`, `LspRange { start: LspPosition; end: LspPosition }`, `LspDiagnostic { range: LspRange; severity: 1 | 2 | 3 | 4; message: string; source?: string }`, `LspDiagnosticsEvent { path: string; diagnostics: LspDiagnostic[] }`, `LspSyncParams { path: string; content: string }`, `LspHoverParams { path: string; position: LspPosition }`, `LspHoverResult { contents: string | null }`, `LspDefinitionParams { path: string; position: LspPosition }`, `LspDefinitionLocation { path: string; range: LspRange }`, `LspDefinitionResult { locations: LspDefinitionLocation[] }`, `LspContextAtParams { path: string; position: LspPosition }`, `LspContextChunk { text: string; score: number }`, `LspContextAtResult { chunks: LspContextChunk[] }`.

- [ ] **Step 1: Add the interfaces**

Append to `packages/protocol/src/messages.ts`:

```typescript
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
/** 1=Error, 2=Warning, 3=Information, 4=Hint — matches LSP's DiagnosticSeverity. */
export interface LspDiagnostic { range: LspRange; severity: 1 | 2 | 3 | 4; message: string; source?: string }
export interface LspDiagnosticsEvent { path: string; diagnostics: LspDiagnostic[] }
export interface LspSyncParams { path: string; content: string }
export interface LspHoverParams { path: string; position: LspPosition }
export interface LspHoverResult { contents: string | null }
export interface LspDefinitionParams { path: string; position: LspPosition }
export interface LspDefinitionLocation { path: string; range: LspRange }
export interface LspDefinitionResult { locations: LspDefinitionLocation[] }
export interface LspContextAtParams { path: string; position: LspPosition }
export interface LspContextChunk { text: string; score: number }
export interface LspContextAtResult { chunks: LspContextChunk[] }
```

- [ ] **Step 2: Extend the round-trip test**

Add to `packages/protocol/src/messages.test.ts`:

```typescript
test("lsp message shapes are plain JSON-serializable", () => {
  const diag: LspDiagnosticsEvent = {
    path: "a.ts",
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "boom" }],
  };
  const hover: LspHoverResult = { contents: "const x: number" };
  const def: LspDefinitionResult = { locations: [{ path: "b.ts", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }] };
  expect(JSON.parse(JSON.stringify(diag))).toEqual(diag);
  expect(JSON.parse(JSON.stringify(hover))).toEqual(hover);
  expect(JSON.parse(JSON.stringify(def))).toEqual(def);
});
```

Add `LspDiagnosticsEvent, LspHoverResult, LspDefinitionResult` to the test file's import from `"./messages"`.

- [ ] **Step 3: Run the test, typecheck, and commit**

Run: `bun test packages/protocol/src/messages.test.ts && bunx tsc -b`
Expected: PASS, no type errors.

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add LSP RPC message types"
```

---

## Task 3: Daemon — `PtyService`

**Files:**
- Create: `packages/daemon/src/pty.ts`
- Test: `packages/daemon/src/pty.test.ts`
- Modify: `packages/daemon/package.json` (add `node-pty` dependency)

**Interfaces:**
- Consumes: `PtySessionInfo` from `@zero/protocol`.
- Produces: `PtyService` class with `open(shell: string | undefined, cols: number, rows: number): { sessionId: string; shell: string }`, `input(sessionId: string, data: string): void`, `resize(sessionId: string, cols: number, rows: number): void`, `close(sessionId: string): void`, `list(): PtySessionInfo[]`, `closeAll(): void`. Constructor: `new PtyService(cwd: string, onOutput: (sessionId: string, data: string) => void, onExit: (sessionId: string, exitCode: number) => void)`.

- [ ] **Step 1: Add the `node-pty` dependency**

Edit `packages/daemon/package.json`, add to `dependencies`:

```json
"node-pty": "^1.0.0"
```

Run: `bun install`

- [ ] **Step 2: Write the failing tests**

Create `packages/daemon/src/pty.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { PtyService } from "./pty";

test("open spawns a shell, input/output round-trips, close kills it", async () => {
  const output: { sessionId: string; data: string }[] = [];
  const exits: { sessionId: string; exitCode: number }[] = [];
  const service = new PtyService(
    process.cwd(),
    (sessionId, data) => output.push({ sessionId, data }),
    (sessionId, exitCode) => exits.push({ sessionId, exitCode }),
  );

  const { sessionId, shell } = service.open("/bin/sh", 80, 24);
  expect(shell).toBe("/bin/sh");
  expect(service.list()).toEqual([{ sessionId, shell: "/bin/sh" }]);

  service.input(sessionId, "echo hello-pty\n");
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (output.some((o) => o.sessionId === sessionId && o.data.includes("hello-pty"))) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  service.close(sessionId);
  await new Promise((r) => setTimeout(r, 100));
  expect(service.list()).toEqual([]);
});

test("resize does not throw for a live session", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  const { sessionId } = service.open("/bin/sh", 80, 24);
  expect(() => service.resize(sessionId, 100, 40)).not.toThrow();
  service.close(sessionId);
});

test("input/resize/close on an unknown sessionId is a silent no-op", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  expect(() => service.input("nope", "x")).not.toThrow();
  expect(() => service.resize("nope", 10, 10)).not.toThrow();
  expect(() => service.close("nope")).not.toThrow();
});

test("closeAll kills every session", () => {
  const exits: string[] = [];
  const service = new PtyService(process.cwd(), () => {}, (sessionId) => exits.push(sessionId));
  const a = service.open("/bin/sh", 80, 24).sessionId;
  const b = service.open("/bin/sh", 80, 24).sessionId;
  service.closeAll();
  expect(service.list()).toEqual([]);
  expect(exits.sort()).toEqual([a, b].sort());
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/daemon/src/pty.test.ts`
Expected: FAIL — `./pty` does not exist yet.

- [ ] **Step 4: Implement `PtyService`**

Create `packages/daemon/src/pty.ts`:

```typescript
import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import type { PtySessionInfo } from "@zero/protocol";

interface Session { sessionId: string; shell: string; proc: pty.IPty }

export class PtyService {
  #sessions = new Map<string, Session>();

  constructor(
    private cwd: string,
    private onOutput: (sessionId: string, data: string) => void,
    private onExit: (sessionId: string, exitCode: number) => void,
  ) {}

  open(shell: string | undefined, cols: number, rows: number): { sessionId: string; shell: string } {
    const sessionId = randomUUID();
    const shellCmd = shell ?? (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash"));
    const proc = pty.spawn(shellCmd, [], {
      name: "xterm-256color", cols, rows, cwd: this.cwd,
      env: process.env as Record<string, string>,
    });
    proc.onData((data) => this.onOutput(sessionId, data));
    proc.onExit(({ exitCode }) => {
      this.#sessions.delete(sessionId);
      this.onExit(sessionId, exitCode);
    });
    this.#sessions.set(sessionId, { sessionId, shell: shellCmd, proc });
    return { sessionId, shell: shellCmd };
  }

  input(sessionId: string, data: string): void {
    this.#sessions.get(sessionId)?.proc.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#sessions.get(sessionId)?.proc.resize(cols, rows);
  }

  close(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.proc.kill();
    this.#sessions.delete(sessionId);
  }

  list(): PtySessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ sessionId: s.sessionId, shell: s.shell }));
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) session.proc.kill();
    this.#sessions.clear();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/daemon/src/pty.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/daemon/package.json packages/daemon/src/pty.ts packages/daemon/src/pty.test.ts bun.lock
git commit -m "feat(daemon): add PtyService"
```

---

## Task 4: Daemon — wire PTY RPCs and broadcasts into `main.ts`

**Files:**
- Modify: `packages/daemon/src/main.ts`
- Test: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Consumes: `PtyService` from `./pty`; `daemon.rpc.register`, `daemon.broadcast` from `./server` (unchanged signatures).
- Produces: RPC methods `pty/open`, `pty/input`, `pty/resize`, `pty/close`, `pty/list`; broadcast events `pty/output` (`PtyOutputEvent`), `pty/exit` (`PtyExitEvent`). `startZero(...).stop()` now also tears down every open PTY session.

- [ ] **Step 1: Write the failing integration test**

Add to `packages/daemon/src/main.test.ts` (reuse the existing `wsAdapter` helper already in that file):

```typescript
test("pty methods over the wire: open, input/output, resize, close", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = startZero({ root });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/daemon/src/main.test.ts -t "pty methods over the wire"`
Expected: FAIL — `unknown method pty/open`.

- [ ] **Step 3: Wire the RPCs**

Modify `packages/daemon/src/main.ts`:

```typescript
import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { Workspace } from "./workspace";
import { PtyService } from "./pty";

export function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);
  const pty = new PtyService(
    opts.root,
    (sessionId, data) => daemon.broadcast("pty/output", { sessionId, data }),
    (sessionId, exitCode) => daemon.broadcast("pty/exit", { sessionId, exitCode }),
  );

  daemon.rpc.register("fs/read", z.object({ path: z.string() }),
    async (p) => ({ content: await ws.read(p.path) }));
  daemon.rpc.register("fs/write", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await ws.write(p.path, p.content); return {}; });
  daemon.rpc.register("fs/tree", z.object({}).optional().transform(() => ({})),
    async () => ({ entries: await ws.tree() }));
  daemon.rpc.register("fs/search", z.object({ query: z.string(), caseSensitive: z.boolean().optional() }),
    async (p) => ws.search(p.query, p.caseSensitive));
  daemon.rpc.register("settings/get", z.object({ key: z.string() }),
    async (p) => ({ value: await ws.readSetting(p.key) }));
  daemon.rpc.register("settings/set", z.object({ key: z.string(), value: z.unknown() }),
    async (p) => { await ws.writeSetting(p.key, p.value); return {}; });

  daemon.rpc.register("pty/open", z.object({ shell: z.string().optional(), cols: z.number(), rows: z.number() }),
    async (p) => pty.open(p.shell, p.cols, p.rows));
  daemon.rpc.register("pty/input", z.object({ sessionId: z.string(), data: z.string() }),
    async (p) => { pty.input(p.sessionId, p.data); return {}; });
  daemon.rpc.register("pty/resize", z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    async (p) => { pty.resize(p.sessionId, p.cols, p.rows); return {}; });
  daemon.rpc.register("pty/close", z.object({ sessionId: z.string() }),
    async (p) => { pty.close(p.sessionId); return {}; });
  daemon.rpc.register("pty/list", z.object({}).optional().transform(() => ({})),
    async () => ({ sessions: pty.list() }));

  const unwatch = ws.watch((path) => daemon.broadcast("fs/changed", { path }));
  const stop = daemon.stop;
  return { ...daemon, stop: () => { unwatch(); pty.closeAll(); stop(); } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: PASS (including the pre-existing fs/settings tests).

- [ ] **Step 5: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/daemon/src/main.ts packages/daemon/src/main.test.ts
git commit -m "feat(daemon): wire PTY RPCs and broadcast events"
```

---

## Task 5: Daemon — `LspClient` (single language-server process over stdio)

**Files:**
- Create: `packages/daemon/src/lsp/client.ts`
- Test: `packages/daemon/src/lsp/client.test.ts`
- Modify: `packages/daemon/package.json` (add `vscode-jsonrpc`, `vscode-languageserver-protocol`, `typescript-language-server`, `typescript`, `pyright`)

**Interfaces:**
- Consumes: `LspDiagnostic`, `LspPosition`, `LspRange` from `@zero/protocol`.
- Produces: `LspClient` class. Constructor: `new LspClient(command: string, args: string[], rootPath: string, onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void)`. Methods: `sync(path: string, content: string, languageId: string): Promise<void>`, `hover(path: string, position: LspPosition): Promise<string | null>`, `definition(path: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]>`, `close(path: string): void`, `dispose(): void`.

- [ ] **Step 1: Add dependencies**

Edit `packages/daemon/package.json`, add to `dependencies`:

```json
"vscode-jsonrpc": "^8.2.0",
"vscode-languageserver-protocol": "^3.17.5",
"typescript-language-server": "^4.3.0",
"typescript": "^5.5.0",
"pyright": "^1.1.380"
```

Run: `bun install`

- [ ] **Step 2: Write the failing test**

Create `packages/daemon/src/lsp/client.test.ts`. This is an integration test against the real bundled `typescript-language-server` — matches the design doc's testing section ("a real typescript-language-server in CI"):

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "./client";
import type { LspDiagnostic } from "@zero/protocol";

test("sync produces diagnostics, hover and definition resolve", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lsp-"));
  const filePath = join(root, "a.ts");
  writeFileSync(filePath, "const greeting: string = 42;\n");

  const diagnosticsByPath = new Map<string, LspDiagnostic[]>();
  const client = new LspClient("typescript-language-server", ["--stdio"], root,
    (path, diagnostics) => diagnosticsByPath.set(path, diagnostics));

  await client.sync(filePath, "const greeting: string = 42;\n", "typescript");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (diagnosticsByPath.has(filePath)) { clearInterval(check); resolve(); }
    }, 50);
  });
  expect(diagnosticsByPath.get(filePath)!.length).toBeGreaterThan(0);
  expect(diagnosticsByPath.get(filePath)![0]!.message).toContain("not assignable");

  const validContent = "const greeting: string = \"hi\";\nconsole.log(greeting);\n";
  writeFileSync(filePath, validContent);
  await client.sync(filePath, validContent, "typescript");

  const hover = await client.hover(filePath, { line: 0, character: 6 });
  expect(hover).toBeTruthy();
  expect(hover!.toLowerCase()).toContain("greeting");

  const definitions = await client.definition(filePath, { line: 1, character: 12 });
  expect(definitions.length).toBeGreaterThan(0);
  expect(definitions[0]!.path).toBe(filePath);

  client.close(filePath);
  client.dispose();
}, 20000);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/daemon/src/lsp/client.test.ts`
Expected: FAIL — `./client` does not exist yet.

- [ ] **Step 4: Implement `LspClient`**

Create `packages/daemon/src/lsp/client.ts`:

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as rpc from "vscode-jsonrpc/node";
import {
  InitializeRequest, InitializedNotification, DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification, DidCloseTextDocumentNotification,
  PublishDiagnosticsNotification, HoverRequest, DefinitionRequest,
  type Diagnostic as ProtoDiagnostic, type Location, type LocationLink,
} from "vscode-languageserver-protocol";
import type { LspDiagnostic, LspPosition, LspRange } from "@zero/protocol";

function pathUri(path: string): string {
  return pathToFileURL(path).toString();
}

function fileUriToPath(uri: string): string {
  return new URL(uri).pathname;
}

function toLspDiagnostic(d: ProtoDiagnostic): LspDiagnostic {
  return { range: d.range, severity: (d.severity ?? 1) as 1 | 2 | 3 | 4, message: d.message, source: d.source };
}

/** One spawned language-server process, one workspace root. Full-document
 * sync only (see plan's Global Constraints) — every sync sends the whole
 * buffer text, no incremental ranges. */
export class LspClient {
  #proc: ChildProcessWithoutNullStreams;
  #conn: rpc.MessageConnection;
  #versions = new Map<string, number>();
  #ready: Promise<void>;
  #failed = false;

  constructor(
    command: string, args: string[], rootPath: string,
    private onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) {
    this.#proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#proc.on("error", () => { this.#failed = true; });
    this.#conn = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.#proc.stdout),
      new rpc.StreamMessageWriter(this.#proc.stdin),
    );
    this.#conn.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.onDiagnostics(fileUriToPath(params.uri), params.diagnostics.map(toLspDiagnostic));
    });
    this.#conn.listen();
    this.#ready = this.#conn
      .sendRequest(InitializeRequest.type, {
        processId: process.pid, rootUri: pathToFileURL(rootPath).toString(),
        capabilities: {}, workspaceFolders: null,
      })
      .then(() => { this.#conn.sendNotification(InitializedNotification.type, {}); })
      .catch(() => { this.#failed = true; });
  }

  /** Every public method awaits readiness (or a failed init) first, so a
   * still-initializing or dead server degrades to a no-op/null rather than
   * hanging the caller forever. */
  async #awaitReady(): Promise<boolean> {
    await this.#ready.catch(() => {});
    return !this.#failed;
  }

  async sync(path: string, content: string, languageId: string): Promise<void> {
    if (!(await this.#awaitReady())) return;
    const uri = pathUri(path);
    const existing = this.#versions.get(path);
    if (existing === undefined) {
      this.#versions.set(path, 1);
      this.#conn.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }
    const version = existing + 1;
    this.#versions.set(path, version);
    this.#conn.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
  }

  async hover(path: string, position: LspPosition): Promise<string | null> {
    if (!(await this.#awaitReady())) return null;
    const result = await this.#conn.sendRequest(HoverRequest.type, {
      textDocument: { uri: pathUri(path) }, position,
    });
    if (!result) return null;
    const contents = result.contents;
    if (typeof contents === "string") return contents;
    if (Array.isArray(contents)) {
      return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
    }
    return "value" in contents ? contents.value : null;
  }

  async definition(path: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]> {
    if (!(await this.#awaitReady())) return [];
    const result = await this.#conn.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: pathUri(path) }, position,
    });
    const raw: (Location | LocationLink)[] = Array.isArray(result) ? result : result ? [result] : [];
    return raw.map((loc) =>
      "uri" in loc
        ? { path: fileUriToPath(loc.uri), range: loc.range }
        : { path: fileUriToPath(loc.targetUri), range: loc.targetSelectionRange },
    );
  }

  close(path: string): void {
    if (!this.#versions.delete(path)) return;
    this.#conn.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: pathUri(path) } });
  }

  dispose(): void {
    this.#conn.dispose();
    this.#proc.kill();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/daemon/src/lsp/client.test.ts`
Expected: PASS. (This is a real process spawn + real TS diagnostics; if it's flaky on first run because `typescript-language-server` needs to resolve the workspace's TypeScript install, re-run once — do not weaken the test to skip it.)

- [ ] **Step 6: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/daemon/package.json packages/daemon/src/lsp/client.ts packages/daemon/src/lsp/client.test.ts bun.lock
git commit -m "feat(daemon): add LspClient wrapping a single language server"
```

---

## Task 6: Daemon — `LspService` (registry, routing, contextAt) and `main.ts` wiring

**Files:**
- Create: `packages/daemon/src/lsp/registry.ts`
- Create: `packages/daemon/src/lsp/service.ts`
- Test: `packages/daemon/src/lsp/registry.test.ts`
- Test: `packages/daemon/src/lsp/service.test.ts`
- Modify: `packages/daemon/src/main.ts`
- Test: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Consumes: `LspClient` from `./client`; `LspDiagnostic`, `LspPosition`, `LspRange`, `LspContextChunk` from `@zero/protocol`.
- Produces: `LspServerConfig { command: string; args: string[]; languageIds: string[] }`, `DEFAULT_LSP_SERVERS: Record<string, LspServerConfig>`, `languageForPath(path: string): string | undefined`. `LspService` class: constructor `new LspService(root: string, servers: Record<string, LspServerConfig>, onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void)`; methods `sync(relPath: string, content: string): Promise<void>`, `hover(relPath: string, position: LspPosition): Promise<string | null>`, `definition(relPath: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]>`, `contextAt(relPath: string, position: LspPosition): Promise<LspContextChunk[]>`, `dispose(): void`.

- [ ] **Step 1: Write the registry test**

Create `packages/daemon/src/lsp/registry.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { DEFAULT_LSP_SERVERS, languageForPath } from "./registry";

test("default registry covers typescript and python by extension", () => {
  expect(languageForPath("a.ts")).toBe("typescript");
  expect(languageForPath("a.tsx")).toBe("typescriptreact");
  expect(languageForPath("a.js")).toBe("javascript");
  expect(languageForPath("a.jsx")).toBe("javascriptreact");
  expect(languageForPath("a.py")).toBe("python");
  expect(languageForPath("a.md")).toBeUndefined();

  expect(DEFAULT_LSP_SERVERS.typescript!.languageIds).toContain("typescript");
  expect(DEFAULT_LSP_SERVERS.python!.languageIds).toContain("python");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/daemon/src/lsp/registry.test.ts`
Expected: FAIL — `./registry` does not exist yet.

- [ ] **Step 3: Implement the registry**

Create `packages/daemon/src/lsp/registry.ts`:

```typescript
import { extname } from "node:path";

export interface LspServerConfig { command: string; args: string[]; languageIds: string[] }

export const DEFAULT_LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: "typescript-language-server", args: ["--stdio"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  python: {
    command: "pyright-langserver", args: ["--stdio"],
    languageIds: ["python"],
  },
};

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", py: "python",
};

export function languageForPath(path: string): string | undefined {
  return EXT_LANGUAGE[extname(path).slice(1)];
}
```

- [ ] **Step 4: Run it to verify it passes, then write the service test**

Run: `bun test packages/daemon/src/lsp/registry.test.ts` — expect PASS.

Create `packages/daemon/src/lsp/service.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspService } from "./service";
import { DEFAULT_LSP_SERVERS } from "./registry";
import type { LspDiagnostic } from "@zero/protocol";

test("routes by extension, syncs, and answers hover/definition/contextAt", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  writeFileSync(join(root, "a.ts"), "const greeting: string = \"hi\";\nconsole.log(greeting);\n");

  const diagnostics = new Map<string, LspDiagnostic[]>();
  const service = new LspService(root, DEFAULT_LSP_SERVERS, (path, d) => diagnostics.set(path, d));

  await service.sync("a.ts", "const greeting: string = \"hi\";\nconsole.log(greeting);\n");
  const hover = await service.hover("a.ts", { line: 0, character: 6 });
  expect(hover).toBeTruthy();

  const chunks = await service.contextAt("a.ts", { line: 0, character: 6 });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.text).toBe(hover);

  const definitions = await service.definition("a.ts", { line: 1, character: 12 });
  expect(definitions.length).toBeGreaterThan(0);
  expect(definitions[0]!.path).toBe("a.ts"); // returned relative to root

  service.dispose();
}, 20000);

test("an unconfigured extension is a silent no-op, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  const service = new LspService(root, DEFAULT_LSP_SERVERS, () => {});
  await expect(service.sync("README.md", "# hi")).resolves.toBeUndefined();
  expect(await service.hover("README.md", { line: 0, character: 0 })).toBeNull();
  expect(await service.contextAt("README.md", { line: 0, character: 0 })).toEqual([]);
  service.dispose();
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `bun test packages/daemon/src/lsp/service.test.ts`
Expected: FAIL — `./service` does not exist yet.

- [ ] **Step 6: Implement `LspService`**

Create `packages/daemon/src/lsp/service.ts`:

```typescript
import { join, relative } from "node:path";
import type { LspDiagnostic, LspPosition, LspRange, LspContextChunk } from "@zero/protocol";
import { LspClient } from "./client";
import { type LspServerConfig, languageForPath } from "./registry";

export class LspService {
  #clients = new Map<string, LspClient>(); // keyed by registry entry key, e.g. "typescript"

  constructor(
    private root: string,
    private servers: Record<string, LspServerConfig>,
    private onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) {}

  #resolve(relPath: string): { client: LspClient; languageId: string; absPath: string } | undefined {
    const languageId = languageForPath(relPath);
    if (!languageId) return undefined;
    const entry = Object.entries(this.servers).find(([, cfg]) => cfg.languageIds.includes(languageId));
    if (!entry) return undefined;
    const [key, cfg] = entry;
    let client = this.#clients.get(key);
    if (!client) {
      client = new LspClient(cfg.command, cfg.args, this.root,
        (absPath, diagnostics) => this.onDiagnostics(relative(this.root, absPath), diagnostics));
      this.#clients.set(key, client);
    }
    return { client, languageId, absPath: join(this.root, relPath) };
  }

  async sync(relPath: string, content: string): Promise<void> {
    const found = this.#resolve(relPath);
    if (!found) return;
    await found.client.sync(found.absPath, content, found.languageId);
  }

  async hover(relPath: string, position: LspPosition): Promise<string | null> {
    const found = this.#resolve(relPath);
    if (!found) return null;
    return found.client.hover(found.absPath, position);
  }

  async definition(relPath: string, position: LspPosition): Promise<{ path: string; range: LspRange }[]> {
    const found = this.#resolve(relPath);
    if (!found) return [];
    const locations = await found.client.definition(found.absPath, position);
    return locations.map((l) => ({ path: relative(this.root, l.path), range: l.range }));
  }

  /** Purpose-built for `LspContext`: today this is hover text at the cursor,
   * scored below buffer/graph context. Extend here (signature help, nearby
   * symbol docs) without changing `LspContext`'s shape. */
  async contextAt(relPath: string, position: LspPosition): Promise<LspContextChunk[]> {
    const hover = await this.hover(relPath, position);
    if (!hover) return [];
    return [{ text: hover, score: 0.6 }];
  }

  dispose(): void {
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
  }
}
```

- [ ] **Step 7: Run the service test to verify it passes**

Run: `bun test packages/daemon/src/lsp/service.test.ts`
Expected: PASS.

- [ ] **Step 8: Wire `LspService` into `main.ts`**

Modify `packages/daemon/src/main.ts` — add the LSP registry/settings resolution and RPCs. The `lsp.servers` setting overrides/extends `DEFAULT_LSP_SERVERS` (merged, not replaced, so overriding `typescript` doesn't silently drop `python`):

```typescript
import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { Workspace } from "./workspace";
import { PtyService } from "./pty";
import { LspService } from "./lsp/service";
import { DEFAULT_LSP_SERVERS, type LspServerConfig } from "./lsp/registry";

export async function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);
  const pty = new PtyService(
    opts.root,
    (sessionId, data) => daemon.broadcast("pty/output", { sessionId, data }),
    (sessionId, exitCode) => daemon.broadcast("pty/exit", { sessionId, exitCode }),
  );

  const userServers = (await ws.readSetting("lsp.servers")) as Record<string, LspServerConfig> | undefined;
  const servers = { ...DEFAULT_LSP_SERVERS, ...(userServers ?? {}) };
  const lsp = new LspService(opts.root, servers,
    (path, diagnostics) => daemon.broadcast("lsp/diagnostics", { path, diagnostics }));

  daemon.rpc.register("fs/read", z.object({ path: z.string() }),
    async (p) => ({ content: await ws.read(p.path) }));
  daemon.rpc.register("fs/write", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await ws.write(p.path, p.content); return {}; });
  daemon.rpc.register("fs/tree", z.object({}).optional().transform(() => ({})),
    async () => ({ entries: await ws.tree() }));
  daemon.rpc.register("fs/search", z.object({ query: z.string(), caseSensitive: z.boolean().optional() }),
    async (p) => ws.search(p.query, p.caseSensitive));
  daemon.rpc.register("settings/get", z.object({ key: z.string() }),
    async (p) => ({ value: await ws.readSetting(p.key) }));
  daemon.rpc.register("settings/set", z.object({ key: z.string(), value: z.unknown() }),
    async (p) => { await ws.writeSetting(p.key, p.value); return {}; });

  daemon.rpc.register("pty/open", z.object({ shell: z.string().optional(), cols: z.number(), rows: z.number() }),
    async (p) => pty.open(p.shell, p.cols, p.rows));
  daemon.rpc.register("pty/input", z.object({ sessionId: z.string(), data: z.string() }),
    async (p) => { pty.input(p.sessionId, p.data); return {}; });
  daemon.rpc.register("pty/resize", z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    async (p) => { pty.resize(p.sessionId, p.cols, p.rows); return {}; });
  daemon.rpc.register("pty/close", z.object({ sessionId: z.string() }),
    async (p) => { pty.close(p.sessionId); return {}; });
  daemon.rpc.register("pty/list", z.object({}).optional().transform(() => ({})),
    async () => ({ sessions: pty.list() }));

  const lspPosition = z.object({ line: z.number(), character: z.number() });
  daemon.rpc.register("lsp/sync", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await lsp.sync(p.path, p.content); return {}; });
  daemon.rpc.register("lsp/hover", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ contents: await lsp.hover(p.path, p.position) }));
  daemon.rpc.register("lsp/definition", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ locations: await lsp.definition(p.path, p.position) }));
  daemon.rpc.register("lsp/contextAt", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ chunks: await lsp.contextAt(p.path, p.position) }));

  const unwatch = ws.watch((path) => daemon.broadcast("fs/changed", { path }));
  const stop = daemon.stop;
  return { ...daemon, stop: () => { unwatch(); pty.closeAll(); lsp.dispose(); stop(); } };
}
```

`startZero` becomes `async` (it now reads a setting before returning). Its only call site is `packages/daemon/bin/zero.ts`:

```typescript
import { resolve } from "node:path";
import { startZero } from "../src/main";

const root = resolve(process.argv[2] ?? ".");
const webDist = new URL("../../web/dist", import.meta.url).pathname;
const d = await startZero({ root, port: 4820, webDist });
console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
```

(Only the `startZero(...)` line changes — add `await`. Top-level `await` is valid here: this file is an ESM module executed directly, not imported.)

- [ ] **Step 9: Update the existing `main.test.ts` calls and add an LSP wire test**

Every existing `startZero({ root })` call in `packages/daemon/src/main.test.ts` (and the PTY test from Task 4) must become `await startZero({ root })`. Add:

```typescript
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
```

- [ ] **Step 10: Run the full daemon test suite to verify everything passes**

Run: `bun test packages/daemon`
Expected: PASS.

- [ ] **Step 11: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/daemon/src/main.ts packages/daemon/src/main.test.ts packages/daemon/src/lsp packages/daemon/bin/zero.ts
git commit -m "feat(daemon): add LspService and wire LSP RPCs/diagnostics"
```

---

## Task 7: Core — `LspContext`

**Files:**
- Create: `packages/core/src/lspContext.ts`
- Test: `packages/core/src/lspContext.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ContextProvider`, `ContextChunk`, `CompletionRequest` from `./types`; `estimateTokens` from `./tokens`.
- Produces: `LspContextClient { request<R>(method: string, params?: unknown): Promise<R> }`, `LspContext implements ContextProvider` with `name = "lsp"` and `gather(req: CompletionRequest): Promise<ContextChunk[]>`, calling `client.request<{ chunks: { text: string; score: number }[] }>("lsp/contextAt", { path, position })`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/lspContext.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { LspContext, type LspContextClient } from "./lspContext";

function fakeClient(response: { chunks: { text: string; score: number }[] }): LspContextClient {
  return { request: async () => response as never };
}

test("gather converts lsp/contextAt chunks into ContextChunks with computed cursor position", async () => {
  let sentParams: unknown;
  const client: LspContextClient = {
    request: async (method, params) => {
      sentParams = params;
      expect(method).toBe("lsp/contextAt");
      return { chunks: [{ text: "const x: number", score: 0.6 }] } as never;
    },
  };
  const ctx = new LspContext(client);
  const chunks = await ctx.gather({ path: "a.ts", prefix: "line one\nconst x", suffix: " = 1;" });

  expect(sentParams).toEqual({ path: "a.ts", position: { line: 1, character: 8 } });
  expect(chunks).toEqual([{ source: "lsp", text: "const x: number", score: 0.6, tokenCost: 4 }]);
});

test("gather returns no chunks when the daemon has nothing", async () => {
  const ctx = new LspContext(fakeClient({ chunks: [] }));
  expect(await ctx.gather({ path: "a.ts", prefix: "", suffix: "" })).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/lspContext.test.ts`
Expected: FAIL — `./lspContext` does not exist yet.

- [ ] **Step 3: Implement `LspContext`**

Create `packages/core/src/lspContext.ts`:

```typescript
import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";
import { estimateTokens } from "./tokens";

export interface LspContextClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

/** Cursor position is implicit in a FIM-style `CompletionRequest`: it's
 * exactly where `prefix` ends. Converting to LSP's 0-based line/character
 * needs the prefix's last line only. */
function cursorPosition(prefix: string): { line: number; character: number } {
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

export class LspContext implements ContextProvider {
  name = "lsp";
  constructor(private client: LspContextClient) {}

  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    const result = await this.client.request<{ chunks: { text: string; score: number }[] }>(
      "lsp/contextAt", { path: req.path, position: cursorPosition(req.prefix) },
    );
    return result.chunks.map((c) => ({ source: "lsp", text: c.text, score: c.score, tokenCost: estimateTokens(c.text) }));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/core/src/lspContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from `packages/core/src/index.ts`**

Add:

```typescript
export { LspContext, type LspContextClient } from "./lspContext";
```

- [ ] **Step 6: Run the full core suite, typecheck, and commit**

Run: `bun test packages/core && bunx tsc -b`
Expected: PASS, no errors.

```bash
git add packages/core/src/lspContext.ts packages/core/src/lspContext.test.ts packages/core/src/index.ts
git commit -m "feat(core): add LspContext provider"
```

---

## Task 8: Web — wire `LspContext` into completion setup

**Files:**
- Modify: `packages/web/src/completionSetup.ts`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `LspContext` from `@zero/core`; `RpcClient` from `@zero/protocol` (already the type of `client` in `Workbench.tsx`).
- Produces: `createCompletion(client: RpcClient, getView, path)` (new first parameter; `RpcClient.request` already matches `LspContextClient`'s shape).

- [ ] **Step 1: Update `createCompletion`**

Modify `packages/web/src/completionSetup.ts`:

```typescript
import { CompletionEngine, CompletionScheduler, BufferContext, LspContext,
  ChromeNanoProvider, OpenAICompatProvider, type NanoApi } from "@zero/core";
import type { EditorView } from "@codemirror/view";
import type { RpcClient } from "@zero/protocol";
import { setSuggestion } from "./ghostText";

export function createCompletion(client: RpcClient, getView: () => EditorView | undefined, path: () => string) {
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
    context: [buffers, new LspContext(client)],
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

- [ ] **Step 2: Update the call site**

In `packages/web/src/workbench/layout/Workbench.tsx`, find:

```typescript
const completion = useConst(() =>
  createCompletion(
    () => views.get(activeGroupIdRef.current),
    () => activePathRef.current ?? "",
  ),
);
```

Replace with:

```typescript
const completion = useConst(() =>
  createCompletion(
    client,
    () => views.get(activeGroupIdRef.current),
    () => activePathRef.current ?? "",
  ),
);
```

- [ ] **Step 3: Typecheck and check the existing web build**

Run: `bunx tsc -b`
Expected: no errors. There's no `completionSetup.test.ts` today (no test infra for this module — it's plain wiring); this task doesn't add one, consistent with the existing pattern.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/completionSetup.ts packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): feed LspContext into the completion engine"
```

---

## Task 9: Web — `PtyStore`

**Files:**
- Create: `packages/web/src/workbench/terminal/store.ts`
- Test: `packages/web/src/workbench/terminal/store.test.ts`

**Interfaces:**
- Produces: `TerminalSession { sessionId: string; shell: string }`. `PtyStore` class: `getSessions(): TerminalSession[]`, `getActiveId(): string | null`, `setActive(sessionId: string): void`, `addSession(session: TerminalSession): void`, `removeSession(sessionId: string): void`, `hasSession(sessionId: string): boolean`, `onOutput(sessionId: string, listener: (data: string) => void): () => void`, `handleOutput(sessionId: string, data: string): void`, `handleExit(sessionId: string): void`, `subscribe(listener: () => void): () => void`.

This mirrors `TabStore`'s subscribe/notify shape (`packages/web/src/workbench/tabs/store.ts`), plus a second, per-session output pub/sub so each mounted xterm instance only receives its own session's data instead of every listener re-filtering every event.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/workbench/terminal/store.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { PtyStore } from "./store";

test("addSession makes it active; removeSession falls back to another session", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  expect(store.getActiveId()).toBe("a");
  store.addSession({ sessionId: "b", shell: "/bin/bash" });
  expect(store.getActiveId()).toBe("b");
  store.removeSession("b");
  expect(store.getActiveId()).toBe("a");
  expect(store.getSessions()).toEqual([{ sessionId: "a", shell: "/bin/bash" }]);
  store.removeSession("a");
  expect(store.getActiveId()).toBeNull();
});

test("onOutput only fires for its own sessionId", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  store.addSession({ sessionId: "b", shell: "/bin/bash" });
  const aChunks: string[] = [];
  const bChunks: string[] = [];
  store.onOutput("a", (d) => aChunks.push(d));
  store.onOutput("b", (d) => bChunks.push(d));
  store.handleOutput("a", "hello-a");
  store.handleOutput("b", "hello-b");
  expect(aChunks).toEqual(["hello-a"]);
  expect(bChunks).toEqual(["hello-b"]);
});

test("handleExit removes the session and notifies subscribers", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.handleExit("a");
  expect(store.hasSession("a")).toBe(false);
  expect(notified).toBe(1);
});

test("unsubscribed onOutput listener stops receiving data", () => {
  const store = new PtyStore();
  store.addSession({ sessionId: "a", shell: "/bin/bash" });
  const chunks: string[] = [];
  const unsubscribe = store.onOutput("a", (d) => chunks.push(d));
  store.handleOutput("a", "one");
  unsubscribe();
  store.handleOutput("a", "two");
  expect(chunks).toEqual(["one"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/web/src/workbench/terminal/store.test.ts`
Expected: FAIL — `./store` does not exist yet.

- [ ] **Step 3: Implement `PtyStore`**

Create `packages/web/src/workbench/terminal/store.ts`:

```typescript
export interface TerminalSession { sessionId: string; shell: string }

export class PtyStore {
  #sessions: TerminalSession[] = [];
  #activeId: string | null = null;
  #listeners = new Set<() => void>();
  #outputListeners = new Map<string, Set<(data: string) => void>>();

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  getSessions(): TerminalSession[] {
    return this.#sessions;
  }

  getActiveId(): string | null {
    return this.#activeId;
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.some((s) => s.sessionId === sessionId);
  }

  setActive(sessionId: string): void {
    if (!this.hasSession(sessionId)) return;
    this.#activeId = sessionId;
    this.#notify();
  }

  addSession(session: TerminalSession): void {
    if (this.hasSession(session.sessionId)) return;
    this.#sessions.push(session);
    this.#activeId = session.sessionId;
    this.#notify();
  }

  removeSession(sessionId: string): void {
    const idx = this.#sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx === -1) return;
    this.#sessions.splice(idx, 1);
    this.#outputListeners.delete(sessionId);
    if (this.#activeId === sessionId) {
      this.#activeId = this.#sessions[idx]?.sessionId ?? this.#sessions[idx - 1]?.sessionId ?? null;
    }
    this.#notify();
  }

  onOutput(sessionId: string, listener: (data: string) => void): () => void {
    let set = this.#outputListeners.get(sessionId);
    if (!set) { set = new Set(); this.#outputListeners.set(sessionId, set); }
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  handleOutput(sessionId: string, data: string): void {
    for (const listener of this.#outputListeners.get(sessionId) ?? []) listener(data);
  }

  handleExit(sessionId: string): void {
    this.removeSession(sessionId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass, typecheck, and commit**

Run: `bun test packages/web/src/workbench/terminal/store.test.ts && bunx tsc -b`
Expected: PASS, no errors.

```bash
git add packages/web/src/workbench/terminal/store.ts packages/web/src/workbench/terminal/store.test.ts
git commit -m "feat(web): add PtyStore"
```

---

## Task 10: Web — terminal panel UI (xterm.js + tab strip)

**Files:**
- Create: `packages/web/src/workbench/terminal/TerminalHost.tsx`
- Create: `packages/web/src/workbench/terminal/TerminalPanel.tsx`
- Modify: `packages/web/package.json` (add `@xterm/xterm`, `@xterm/addon-fit`)

**Interfaces:**
- Consumes: `PtyStore`, `TerminalSession` from `./store`; `RpcClient` from `@zero/protocol`.
- Produces: `TerminalHost` (one xterm.js instance bound to one `sessionId`, mounted/hidden not destroyed/recreated on tab switch), `TerminalPanel` (dockview panel component: tab strip + all `TerminalHost`s, one visible at a time).

- [ ] **Step 1: Add xterm dependencies**

Edit `packages/web/package.json`, add to `dependencies`:

```json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

Run: `bun install`

- [ ] **Step 2: Implement `TerminalHost`**

Create `packages/web/src/workbench/terminal/TerminalHost.tsx`. One xterm `Terminal` per session, created once and kept alive (not destroyed) across tab switches — switching only toggles CSS `display`, which preserves scrollback and avoids the reattach cost of tearing xterm down:

```typescript
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { RpcClient } from "@zero/protocol";
import type { PtyStore } from "./store";
import "@xterm/xterm/css/xterm.css";

export function TerminalHost(props: {
  client: RpcClient;
  ptyStore: PtyStore;
  sessionId: string;
  visible: boolean;
  theme: "light" | "dark";
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>();
  const fit = useRef<FitAddon>();

  useEffect(() => {
    const t = new Terminal({
      convertEol: true,
      fontFamily: "'FiraCode Nerd Font', 'Fira Code', monospace",
      theme: props.theme === "dark"
        ? { background: "#1e1e2e", foreground: "#cdd6f4" }
        : { background: "#ffffff", foreground: "#1d1d1f" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    f.fit();
    term.current = t;
    fit.current = f;

    t.onData((data) => {
      void props.client.request("pty/input", { sessionId: props.sessionId, data });
    });

    const unsubscribeOutput = props.ptyStore.onOutput(props.sessionId, (data) => t.write(data));

    const onResize = () => {
      f.fit();
      void props.client.request("pty/resize", { sessionId: props.sessionId, cols: t.cols, rows: t.rows });
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(host.current!);

    return () => {
      unsubscribeOutput();
      observer.disconnect();
      t.dispose();
    };
    // A TerminalHost is created once per sessionId (key'd by the caller) and
    // never reconfigured, so this effect intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.visible) fit.current?.fit();
  }, [props.visible]);

  return <div ref={host} style={{ height: "100%", display: props.visible ? "block" : "none", padding: 4 }} />;
}
```

- [ ] **Step 3: Implement `TerminalPanel`**

Create `packages/web/src/workbench/terminal/TerminalPanel.tsx`:

```typescript
import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { TerminalHost } from "./TerminalHost";
import type { PtyStore } from "./store";

export function TerminalPanel(props: { client: RpcClient; ptyStore: PtyStore; theme: "light" | "dark" }) {
  const { ptyStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => ptyStore.subscribe(() => setVersion((v) => v + 1)), [ptyStore]);

  const sessions = ptyStore.getSessions();
  const activeId = ptyStore.getActiveId();

  async function newTerminal(): Promise<void> {
    const { sessionId, shell } = await props.client.request<{ sessionId: string; shell: string }>(
      "pty/open", { cols: 80, rows: 24 });
    ptyStore.addSession({ sessionId, shell });
  }

  function closeTerminal(sessionId: string): void {
    void props.client.request("pty/close", { sessionId });
    ptyStore.removeSession(sessionId);
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}>
      <div className="zero-tabstrip" role="tablist">
        {sessions.map((s) => (
          <div
            key={s.sessionId}
            className="zero-tab"
            role="tab"
            aria-selected={s.sessionId === activeId}
            onClick={() => ptyStore.setActive(s.sessionId)}
          >
            <span>{s.shell.split("/").at(-1)}</span>
            <button className="zero-tab-close" aria-label={`Close terminal ${s.sessionId}`}
              onClick={(e) => { e.stopPropagation(); closeTerminal(s.sessionId); }}>
              ×
            </button>
          </div>
        ))}
        <button aria-label="New terminal" onClick={() => void newTerminal()} style={{ marginLeft: 4 }}>+</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {sessions.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.6 }}>No terminals open</div>
        ) : (
          sessions.map((s) => (
            <TerminalHost key={s.sessionId} client={props.client} ptyStore={ptyStore}
              sessionId={s.sessionId} visible={s.sessionId === activeId} theme={props.theme} />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and commit**

There's no browser test harness in this repo (per the M1.5 plan's constraint — no Playwright infra); `TerminalHost`/`TerminalPanel` are exercised by the manual smoke test in Task 12. Run:

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/web/package.json packages/web/src/workbench/terminal/TerminalHost.tsx packages/web/src/workbench/terminal/TerminalPanel.tsx bun.lock
git commit -m "feat(web): add terminal panel UI (xterm.js)"
```

---

## Task 11: Web — wire the terminal panel into `Workbench.tsx` (bottom dockview panel, commands, reattach)

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `PtyStore` from `../terminal/store`; `TerminalPanel` from `../terminal/TerminalPanel`; `PtyOutputEvent`, `PtyExitEvent`, `PtyListResult` from `@zero/protocol`.
- Produces: dockview panel id `"terminal"` at the bottom, commands `view.toggleTerminal` (keybinding `` Ctrl+` ``) and `terminal.new`, reattach on load via `pty/list` cross-referenced against `localStorage`-persisted session ids.

- [ ] **Step 1: Add the `TerminalPanel` component and `PtyStore` to `DOCKVIEW_COMPONENTS`**

In `packages/web/src/workbench/layout/Workbench.tsx`, add imports:

```typescript
import { PtyStore } from "../terminal/store";
import { TerminalPanel } from "../terminal/TerminalPanel";
import type { PtyOutputEvent, PtyExitEvent, PtyListResult } from "@zero/protocol";
```

Add `ptyStore` to `WorkbenchContextValue`:

```typescript
interface WorkbenchContextValue {
  // ...existing fields...
  ptyStore: PtyStore;
}
```

Add a stable panel component next to `SidebarPanel`/`EditorPanel`:

```typescript
function BottomTerminalPanel() {
  const w = useWorkbench();
  return <TerminalPanel client={w.client} ptyStore={w.ptyStore} theme={w.theme} />;
}
```

Update the stable component map:

```typescript
const DOCKVIEW_COMPONENTS = { sidebar: SidebarPanel, editor: EditorPanel, terminal: BottomTerminalPanel };
```

- [ ] **Step 2: Create the `ptyStore`, track panel visibility, add reattach and the fan-out cases**

Inside `Workbench`, alongside the other `useConst`s:

```typescript
const ptyStore = useConst(() => new PtyStore());
```

Add a ref for panel visibility (dockview panel presence is the source of truth; this ref exists so `toggleTerminal` can check current state without a stale closure):

```typescript
const TERMINAL_PANEL_ID = "terminal";
const TERMINAL_SESSIONS_KEY = "zero.terminal.sessionIds";
```

(Place these two constants near the top of the file next to `SIDEBAR_PANEL_ID`.)

Extend the single `client.onNotification` handler (do not add a second call anywhere — see Global Constraints):

```typescript
useEffect(() => {
  client.onNotification((method, params) => {
    if (method === "pty/output") {
      const { sessionId, data } = params as PtyOutputEvent;
      ptyStore.handleOutput(sessionId, data);
      return;
    }
    if (method === "pty/exit") {
      const { sessionId } = params as PtyExitEvent;
      ptyStore.handleExit(sessionId);
      return;
    }
    if (method !== "fs/changed") return;
    // ...existing fs/changed body unchanged...
  });
}, [client, tabStore, ptyStore]);
```

Reattach on mount — ask the daemon which sessions are still alive, keep only the ones this browser previously knew about:

```typescript
useEffect(() => {
  let cancelled = false;
  void client.request<PtyListResult>("pty/list").then((res) => {
    if (cancelled) return;
    const persisted = new Set(JSON.parse(window.localStorage.getItem(TERMINAL_SESSIONS_KEY) ?? "[]") as string[]);
    for (const session of res.sessions) {
      if (persisted.has(session.sessionId)) ptyStore.addSession(session);
    }
  });
  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [client]);
```

Persist the session id list on every `PtyStore` mutation (new terminal, closed terminal, exited terminal):

```typescript
useEffect(() => ptyStore.subscribe(() => {
  const ids = ptyStore.getSessions().map((s) => s.sessionId);
  window.localStorage.setItem(TERMINAL_SESSIONS_KEY, JSON.stringify(ids));
}), [ptyStore]);
```

- [ ] **Step 3: Add `view.toggleTerminal` / `terminal.new` actions and commands**

Add to the `actions` object:

```typescript
toggleTerminal: () => {
  const api = dockApi.current;
  if (!api) return;
  const panel = api.getPanel(TERMINAL_PANEL_ID);
  if (panel) { api.removePanel(panel); return; }
  api.addPanel({
    id: TERMINAL_PANEL_ID, component: "terminal", params: {},
    position: { direction: "below" },
    initialHeight: 240,
  });
},
newTerminal: () => {
  actionsRef.current.toggleTerminalOpen();
  void client.request<{ sessionId: string; shell: string }>("pty/open", { cols: 80, rows: 24 })
    .then((s) => ptyStore.addSession(s))
    .catch((e: unknown) => reportRef.current(`Could not open terminal: ${errorText(e)}`));
},
```

Correct the helper name above — `toggleTerminal` should ensure the panel is open (not toggle it closed) when called from `newTerminal`. Replace both entries with:

```typescript
showTerminalPanel: () => {
  const api = dockApi.current;
  if (!api || api.getPanel(TERMINAL_PANEL_ID)) return;
  api.addPanel({
    id: TERMINAL_PANEL_ID, component: "terminal", params: {},
    position: { direction: "below" },
    initialHeight: 240,
  });
},
toggleTerminal: () => {
  const api = dockApi.current;
  if (!api) return;
  const panel = api.getPanel(TERMINAL_PANEL_ID);
  if (panel) { api.removePanel(panel); return; }
  actionsRef.current.showTerminalPanel();
},
newTerminal: () => {
  actionsRef.current.showTerminalPanel();
  void client.request<{ sessionId: string; shell: string }>("pty/open", { cols: 80, rows: 24 })
    .then((s) => ptyStore.addSession(s))
    .catch((e: unknown) => reportRef.current(`Could not open terminal: ${errorText(e)}`));
},
```

Add to the `commands` array in the keybindings-registration `useEffect`:

```typescript
{ id: "view.toggleTerminal", title: "Toggle Terminal", run: () => actionsRef.current.toggleTerminal(), keybinding: "Control+Backquote" },
{ id: "terminal.new", title: "New Terminal", run: () => actionsRef.current.newTerminal() },
```

`Control+Backquote` (not `$mod+Backquote`) deliberately matches VS Code's literal Ctrl+` on every platform, including macOS, rather than tinykeys' `$mod` (which would map to Cmd on macOS and collide with nothing today, but Ctrl+` is the convention users expect).

- [ ] **Step 4: Reveal the terminal panel automatically when a reattached session exists**

Extend the reattach effect from Step 2 so a non-empty restored session list also opens the panel:

```typescript
useEffect(() => {
  let cancelled = false;
  void client.request<PtyListResult>("pty/list").then((res) => {
    if (cancelled) return;
    const persisted = new Set(JSON.parse(window.localStorage.getItem(TERMINAL_SESSIONS_KEY) ?? "[]") as string[]);
    let restored = false;
    for (const session of res.sessions) {
      if (persisted.has(session.sessionId)) { ptyStore.addSession(session); restored = true; }
    }
    if (restored) actionsRef.current.showTerminalPanel();
  });
  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [client]);
```

- [ ] **Step 5: Pass `ptyStore` through the context value**

In the `contextValue` object literal, add:

```typescript
ptyStore,
```

- [ ] **Step 6: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): wire terminal panel into the workbench with reattach"
```

---

## Task 12: Web — editor diagnostics via `@codemirror/lint`, status bar LSP health slot

**Files:**
- Modify: `packages/web/package.json` (add `@codemirror/lint`)
- Modify: `packages/web/src/Editor.tsx`
- Modify: `packages/web/src/workbench/StatusBar.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `LspDiagnosticsEvent` from `@zero/protocol`; `linter`, `type Diagnostic as CmDiagnostic`, `forceLinting` from `@codemirror/lint`.
- Produces: `Editor` gains a `diagnostics: LspDiagnostic[]` prop; `StatusBar` gains an `lspStatus: { path: string; count: number } | null` prop rendered as a slot next to `StatusPill`.

- [ ] **Step 1: Add the dependency**

Edit `packages/web/package.json`, add to `dependencies`:

```json
"@codemirror/lint": "^6.8.0"
```

Run: `bun install`

- [ ] **Step 2: Track diagnostics per path in `Workbench.tsx`**

Add state and a fan-out case:

```typescript
const [diagnosticsByPath, setDiagnosticsByPath] = useState<Map<string, LspDiagnostic[]>>(new Map());
```

Import `LspDiagnostic`, `LspDiagnosticsEvent` from `@zero/protocol` alongside the other protocol imports.

Extend the notification handler from Task 11 with one more case:

```typescript
if (method === "lsp/diagnostics") {
  const { path, diagnostics } = params as LspDiagnosticsEvent;
  setDiagnosticsByPath((prev) => {
    const next = new Map(prev);
    next.set(path, diagnostics);
    return next;
  });
  return;
}
```

- [ ] **Step 3: Add a diagnostics prop to `Editor` and wire the linter extension**

Modify `packages/web/src/Editor.tsx`. Add the import:

```typescript
import { linter, type Diagnostic as CmDiagnostic, forceLinting } from "@codemirror/lint";
```

Add a `diagnostics` prop and a helper to convert `LspDiagnostic` (line/character) into CodeMirror's offset-based `Diagnostic`:

```typescript
import type { LspDiagnostic } from "@zero/protocol";

function toCmDiagnostics(doc: EditorState["doc"], diagnostics: LspDiagnostic[]): CmDiagnostic[] {
  return diagnostics.map((d) => {
    const fromLine = doc.line(Math.min(d.range.start.line + 1, doc.lines));
    const toLine = doc.line(Math.min(d.range.end.line + 1, doc.lines));
    const from = Math.min(fromLine.from + d.range.start.character, doc.length);
    const to = Math.min(toLine.from + d.range.end.character, doc.length);
    const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    return { from, to: Math.max(to, from), severity, message: d.message, source: d.source };
  });
}
```

Add `diagnostics?: LspDiagnostic[]` to the `Editor` props type, and in the extensions array add:

```typescript
linter(() => toCmDiagnostics(view.current!.state.doc, propsRef.current.diagnostics ?? [])),
```

Add a new `useEffect` that re-runs the linter when diagnostics for the open file change (the linter extension above only re-runs on doc changes by default, not on an external prop update):

```typescript
useEffect(() => {
  if (view.current) forceLinting(view.current);
}, [props.diagnostics]);
```

- [ ] **Step 4: Pass diagnostics from `EditorPanel` in `Workbench.tsx`**

In `EditorPanel`, pass `diagnostics={w.diagnosticsByPath.get(tab.path) ?? []}` to `<Editor ... />`, and add `diagnosticsByPath: Map<string, LspDiagnostic[]>` to `WorkbenchContextValue` plus the context value object.

- [ ] **Step 5: Add the status bar LSP health slot**

Modify `packages/web/src/workbench/StatusBar.tsx` — add a prop and render it in the right-hand group, before `StatusPill`:

```typescript
export function StatusBar(props: {
  // ...existing props...
  lspStatus: { path: string; count: number } | null;
}) {
  return (
    <div /* ...unchanged... */>
      <div /* ...unchanged left group... */>{/* unchanged */}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {props.lspStatus && props.lspStatus.count > 0 && (
          <span role="status" title={`${props.lspStatus.count} problem(s) in ${props.lspStatus.path}`}
            style={{ color: "var(--zero-error-fg, crimson)" }}>
            {props.lspStatus.count} problem{props.lspStatus.count === 1 ? "" : "s"}
          </span>
        )}
        <StatusPill engine={props.engine} />
        {/* ...unchanged theme button... */}
      </div>
    </div>
  );
}
```

In `Workbench.tsx`, pass:

```typescript
lspStatus={activePath ? { path: activePath, count: (diagnosticsByPath.get(activePath) ?? []).length } : null}
```

to `<StatusBar ... />`.

- [ ] **Step 6: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/web/package.json packages/web/src/Editor.tsx packages/web/src/workbench/StatusBar.tsx packages/web/src/workbench/layout/Workbench.tsx bun.lock
git commit -m "feat(web): show LSP diagnostics in the editor and status bar"
```

---

## Task 13: Web — hover tooltip and go-to-definition

**Files:**
- Modify: `packages/web/src/Editor.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `hoverTooltip` from `@codemirror/view`; `client.request<LspHoverResult>("lsp/hover", ...)`, `client.request<LspDefinitionResult>("lsp/definition", ...)`.
- Produces: `Editor` gains `client: RpcClient` and `onGoToDefinition: (path: string, line: number, character: number) => void` props.

- [ ] **Step 1: Add the hover tooltip extension**

In `packages/web/src/Editor.tsx`, add imports:

```typescript
import { hoverTooltip } from "@codemirror/view";
import type { RpcClient, LspHoverResult, LspDefinitionResult } from "@zero/protocol";
```

Add `client: RpcClient` and `onGoToDefinition?: (path: string, line: number, character: number) => void` to the `Editor` props type.

Add the hover extension (position → offset conversion uses CodeMirror's own `doc.lineAt`, the inverse of `toCmDiagnostics`'s line/character → offset conversion in Task 12):

```typescript
hoverTooltip(async (view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const position = { line: line.number - 1, character: pos - line.from };
  let result: LspHoverResult;
  try {
    result = await propsRef.current.client.request<LspHoverResult>(
      "lsp/hover", { path: propsRef.current.path, position });
  } catch {
    return null;
  }
  if (!result.contents) return null;
  return {
    pos, end: pos,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-tooltip-zero-hover";
      dom.textContent = result.contents;
      dom.style.cssText = "max-width: 480px; white-space: pre-wrap; padding: 6px 8px; font-size: 13px;";
      return { dom };
    },
  };
}),
```

Note `propsRef.current.path` — a hover extension is added once at view-creation time (like `ghostText`), so it must read live props off `propsRef`, matching the rest of this file's established pattern; it must never close over the `path` from the render that created the view.

- [ ] **Step 2: Add go-to-definition (Cmd/Ctrl+Click and F12)**

Add to the `keymap.of([...])` array's list (alongside the existing `Mod-s` binding):

```typescript
{
  key: "F12",
  preventDefault: true,
  run: (v) => {
    const pos = v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    void goToDefinition(v.state.doc, pos, line);
    return true;
  },
},
```

Add a `domEventHandlers` extension for Cmd/Ctrl+Click, and the shared `goToDefinition` helper, both inside the component (they close over `propsRef` and `view`, same as everything else in this file):

```typescript
async function goToDefinition(doc: EditorState["doc"], pos: number, line: ReturnType<EditorState["doc"]["lineAt"]>): Promise<void> {
  const position = { line: line.number - 1, character: pos - line.from };
  let result: LspDefinitionResult;
  try {
    result = await propsRef.current.client.request<LspDefinitionResult>(
      "lsp/definition", { path: propsRef.current.path, position });
  } catch {
    return;
  }
  const target = result.locations[0];
  if (target) propsRef.current.onGoToDefinition?.(target.path, target.range.start.line, target.range.start.character);
}
```

Add to the extensions array:

```typescript
EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    event.preventDefault();
    void goToDefinition(view.state.doc, pos, view.state.doc.lineAt(pos));
    return true;
  },
}),
```

- [ ] **Step 3: Wire `client` and `onGoToDefinition` through `Workbench.tsx`**

In `EditorPanel`, pass `client={w.client}` to `<Editor ... />`, and:

```typescript
onGoToDefinition={(path, line, character) => {
  w.openFile(path);
  // Cursor placement after open happens once the tab's EditorView mounts;
  // the simplest correct thing for M2 is opening the file — landing the
  // cursor precisely requires the view to exist first, which openFile's
  // async fs/read round-trip doesn't guarantee synchronously. Out of scope
  // refinement: thread the target position through TabStore.openFile and
  // have EditorPanel's mount effect dispatch a selection once ready.
}}
```

- [ ] **Step 4: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/web/src/Editor.tsx packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): add hover tooltip and go-to-definition"
```

---

## Task 14: Web — sync buffer edits to the LSP service

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: existing `client`, `tabStore`, `tabsVersion` from `Workbench.tsx`.
- Produces: a debounced effect that calls `lsp/sync` for the active file whenever its content changes, and immediately on `openFile`/`saveTab`, keeping the spawned language server (and therefore diagnostics/hover/definition/contextAt) current with what the user sees rather than only what's on disk — the "dirty-buffer sync" requirement from the design doc's degradation section.

- [ ] **Step 1: Add a debounced sync effect**

Add a constant near the other debounce constants:

```typescript
const LSP_SYNC_DEBOUNCE_MS = 300;
```

Add a ref and effect:

```typescript
const lspSyncDebounceRef = useRef<ReturnType<typeof setTimeout>>();

useEffect(() => {
  if (!activeTab) return;
  clearTimeout(lspSyncDebounceRef.current);
  lspSyncDebounceRef.current = setTimeout(() => {
    void client.request("lsp/sync", { path: activeTab.path, content: activeTab.content }).catch(() => {
      // A missing/unconfigured language server for this file is expected
      // and silent — lsp/sync degrades to a no-op daemon-side (Task 6).
      // A genuine RPC failure here must not surface as a blocking error;
      // diagnostics simply stay stale until the next successful sync.
    });
  }, LSP_SYNC_DEBOUNCE_MS);
  return () => clearTimeout(lspSyncDebounceRef.current);
  // activeTab.content is the trigger; activeTab itself changes identity on
  // every keystroke (TabStore mutates in place but bumps tabsVersion), so
  // depending on tabsVersion + activeTab?.path avoids re-debouncing on
  // unrelated state changes elsewhere in the tree.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [client, activeTab?.path, activeTab?.content]);
```

Add this effect near the existing "Every open buffer is completion context" effect, so buffer-sync concerns stay grouped together.

- [ ] **Step 2: Clear the debounce timer on unmount**

Add `clearTimeout(lspSyncDebounceRef.current);` to the existing cleanup `useEffect` that already clears `statusTimerRef` and `treeDebounceRef`:

```typescript
useEffect(() => () => {
  clearTimeout(statusTimerRef.current);
  clearTimeout(treeDebounceRef.current);
  clearTimeout(lspSyncDebounceRef.current);
}, []);
```

- [ ] **Step 3: Typecheck and commit**

Run: `bunx tsc -b`
Expected: no errors.

```bash
git add packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): debounce-sync buffer edits to the LSP service"
```

---

## Task 15: Manual smoke test

No new automated test infra is added in this plan (matching M1.5's precedent — no Playwright in this repo). Verify the whole slice by hand.

- [ ] **Step 1: Start the daemon against a real TypeScript project**

```bash
bun run --cwd packages/daemon bin/zero.ts /path/to/some/ts/project
```

(Or whatever the existing `bin/zero.ts` invocation convention is — check `packages/daemon/bin/zero.ts` and any `README`/`package.json` script if one exists for the exact command; this plan doesn't change that entry point.)

- [ ] **Step 2: Open the web client, verify the terminal**

- Open the printed `http://localhost:<port>?token=<token>` URL.
- `Ctrl+`` `` opens the terminal panel; a shell prompt appears.
- Type `echo hello` and Enter — output appears.
- Click `+` to open a second terminal tab; switch between tabs — each keeps its own scrollback.
- Reload the browser tab — both terminals reappear (reattached) and remain live (type in one, output still appears); note per the Global Constraints that output produced *during* the reload is not replayed, only new output after reattach.
- Close a terminal tab (`×`) — its shell process exits (verify via `ps aux | grep <shell>` dropping the entry, or simply that no more output appears).

- [ ] **Step 3: Verify LSP features on a `.ts` file**

- Open a `.ts` file with a deliberate type error (e.g. `const x: string = 42;`).
- Confirm a red underline/gutter marker appears under `x` within ~1-2s, and the status bar shows "1 problem".
- Fix the error, save — the marker and status bar count clear.
- Hover over a variable or function name — a tooltip with its type/signature appears.
- Cmd/Ctrl+Click (or place cursor and press F12) on a reference to a symbol defined elsewhere in the same file or another open file — the defining file opens.

- [ ] **Step 4: Verify Python, if a Python project is available**

Repeat step 3's diagnostics/hover checks on a `.py` file in a project where `pyright` can resolve the interpreter (a `venv` or global `python3` on `PATH`). If none is available in the current environment, note this explicitly rather than skipping silently — Python coverage should be verified before this milestone is considered done, even if it happens in a follow-up session with a Python project on hand.

- [ ] **Step 5: Verify completions still work and now include LSP context**

- Place the cursor after a partial expression referencing a typed symbol (e.g. `const y = greeting.` where `greeting: string`) and confirm ghost text still appears (unaffected by `LspContext`'s addition) and, ideally, that suggestions plausibly reflect the string type (a soft check — small models may or may not use the extra context well, per the design doc's "small-model scaling" honesty).

- [ ] **Step 6: Verify graceful degradation**

- Rename `typescript-language-server` out of `node_modules/.bin` temporarily (or point `lsp.servers.typescript.command` via `.zero/settings.json` at a nonexistent binary) and reload.
- Confirm: the editor stays fully usable (typing, saving, completions from other providers), no diagnostics appear for `.ts` files, no uncaught error in the browser console, and the terminal is entirely unaffected.
- Restore the binary/setting afterward.

- [ ] **Step 7: Record results**

If every check in Steps 2-6 passes, M2 is complete. If anything fails, file it as a follow-up rather than silently patching outside this plan's tasks — note the discrepancy in the commit history or a short summary for the person reviewing this milestone.

---

## Self-Review Notes

- **Spec coverage:** PTY service + reattach (Tasks 3, 4, 9, 10, 11) ✓; LSP service for TS/Python (Tasks 5, 6) ✓; diagnostics/hover/definitions (Tasks 6, 12, 13) ✓; `LspContext` feeding completions (Tasks 7, 8) ✓; config-driven, user-overridable registry per the approved design discussion (Task 6, `lsp.servers` setting) ✓; stream/session-id event routing per the approved design discussion (Tasks 4, 6, 9 — no server-side subscription registry) ✓; graceful degradation per design doc section 8 (`LspClient`'s `#failed` flag, `LspService`'s silent no-op on unconfigured extensions, Task 15 Step 6) ✓.
- **Placeholder scan:** no TBD/TODO markers; every step has concrete code or an exact shell command.
- **Type consistency:** `PtyOpenResult`/`PtySessionInfo` both carry `{ sessionId, shell }` consistently across Tasks 1, 3, 4, 10, 11. `LspContextChunk { text, score }` matches between Task 2's protocol type, Task 6's `LspService.contextAt` return, and Task 7's `LspContext.gather` consumption. `LspDiagnostic` (line/character-based `LspRange`) is produced in Task 5's `toLspDiagnostic`, carried through Task 6's broadcast, and consumed by both Task 12's `toCmDiagnostics` (offset conversion) and the editor's diagnostics prop.
- **Scope check:** this is one coherent, bottom-up subsystem addition (terminal + LSP) matching the M2 roadmap line; not decomposed further since PTY and LSP share the same protocol/daemon/web layering pattern and were sized together in the approved design.
