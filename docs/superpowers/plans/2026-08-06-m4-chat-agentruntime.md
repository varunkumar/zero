# M4 Chat / AgentRuntime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a chat panel backed by a client-side `AgentRuntime` turn loop — layered system prompt, session persistence, token ledger, pruning/compaction, and read-only tool calling on capable backends — completing v1 scope per the roadmap.

**Architecture:** Bottom-up, matching the M1/M3 plan style: protocol → daemon → core → web. `@zero/protocol` gains plain `chat/*` message interfaces (no Zod; daemon validates). The daemon gets a file-backed `SessionStore` (`.zero/sessions/<id>.json`) and `chat/*` RPCs registered directly in `main.ts` (not a plugin — this is core daemon functionality, like `fs/*`). `@zero/core` gets chat-capable model providers (`chat()` added to `OpenAICompatProvider` and `ChromeNanoProvider`), a `ToolProvider` interface, a layered system-prompt builder, token-ledger/compaction helpers, and `AgentRuntime` (the turn loop) — all isomorphic, driven only through the existing injected `{ request<R>(method, params?) }` client shape `GraphContext`/`LspContext` already use. `@zero/web` wires daemon-backed tools, instantiates `AgentRuntime` (mirroring `completionSetup.ts`), and adds a `ChatPanel` dockable panel (mirroring `TerminalPanel`).

**Tech Stack:** Existing `zod` (daemon-side validation), `bun:test`, React + `dockview-react` (web), no new dependencies.

**Design:** `docs/superpowers/specs/2026-08-06-m4-chat-agentruntime-design.md`

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs (from `CLAUDE.md`). `AgentRuntime` talks to the daemon only through an injected `{ request<R>(method, params?): Promise<R> }` interface, same as `GraphContext`.
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session token are rejected.
- The editor must stay fully usable when no chat model is available — degrade the chat panel only, never break editing.
- Token estimate convention: `Math.ceil(chars / 4)` (`estimateTokens` in `packages/core/src/tokens.ts`). Reuse it; do not add a second estimator.
- New behavior needs tests alongside it (`*.test.ts` next to each module); `@zero/core` expects dense unit coverage with injected fakes rather than real DOM/Node dependencies.
- Commit after each coherent unit of work; conventional-commit style messages.
- No write tools, no tool-approval gate, no daemon-side `AgentRuntime` in M4 — those are explicitly M5 (Zero Agents). All four tools this plan adds (`fs_read`, `fs_tree`, `fs_search`, `graph_query`, `lsp_hover`, `lsp_definition`) are read-only wrappers over RPCs that already exist.
- `@zero/core` never imports `@zero/protocol` (established convention — see `GraphContext`/`LspContext`, which define their own local result shapes rather than importing the daemon's). `@zero/daemon` does import `@zero/protocol` (already a dependency) — `SessionStore` reuses `ChatMessage` from there directly rather than redeclaring it.
- `.zero/` is already gitignored (Graphify precedent) — no new ignore rule needed for `.zero/sessions/`.

## File map

| Path | Responsibility |
|---|---|
| `packages/protocol/src/messages.ts` | `chat/*` message interfaces |
| `packages/daemon/src/sessions.ts` | `SessionStore`: file-backed session CRUD |
| `packages/daemon/src/main.ts` | Register `chat/*` RPCs |
| `packages/core/src/chatTypes.ts` | `ChatMessage`, `ChatToolCall`, `ChatToolSpec`, `ChatDelta`, `ChatCapableProvider`, `ToolProvider` |
| `packages/core/src/tokenLedger.ts` | Tool-output capping, compaction threshold/selection, compaction prompt |
| `packages/core/src/systemPrompt.ts` | Layered system prompt builder |
| `packages/core/src/providers/openaiCompat.ts` | Add `chat()` + `supportsTools()` |
| `packages/core/src/providers/chromeNano.ts` | Add `chat()` + `supportsTools()` |
| `packages/core/src/agentRuntime.ts` | `AgentRuntime` turn loop, `TurnEvent` |
| `packages/core/src/index.ts` | Export new symbols |
| `packages/web/src/chatTools.ts` | Daemon-backed `ToolProvider[]` |
| `packages/web/src/chatSetup.ts` | Builds `AgentRuntime` for the web client |
| `packages/web/src/workbench/chat/store.ts` | `ChatStore`: session-list state |
| `packages/web/src/workbench/chat/ChatPanel.tsx` | Chat panel UI |
| `packages/web/src/workbench/layout/Workbench.tsx` | Panel registration, actions, commands |
| `README.md` | M4 status update |

---

### Task 1: Protocol — chat message types

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/messages.test.ts`

**Interfaces:**
- Produces: `ChatToolCall`, `ChatMessage`, `ChatSessionSummary`, `ChatCreateParams`, `ChatCreateResult`, `ChatListResult`, `ChatGetParams`, `ChatGetResult`, `ChatAppendParams`, `ChatRenameParams`, `ChatDeleteParams` — consumed by Tasks 2, 3.

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/src/messages.test.ts`:

```ts
import type {
  ChatMessage, ChatCreateParams, ChatCreateResult, ChatListResult,
  ChatGetResult, ChatAppendParams, ChatRenameParams,
} from "./messages";

test("chat message shapes are plain JSON-serializable", () => {
  const msg: ChatMessage = {
    role: "assistant",
    content: "Reading the file now.",
    toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }],
    createdAt: 1000,
  };
  const toolResult: ChatMessage = {
    role: "tool", content: "export const a = 1;", toolCallId: "call_1", toolName: "fs_read", createdAt: 1001,
  };
  expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  expect(JSON.parse(JSON.stringify(toolResult))).toEqual(toolResult);

  const create: ChatCreateParams = { title: "Refactor plan" };
  const createResult: ChatCreateResult = { id: "abc" };
  const list: ChatListResult = { sessions: [{ id: "abc", title: "Refactor plan", updatedAt: 1000, messageCount: 2 }] };
  const get: ChatGetResult = { id: "abc", title: "Refactor plan", messages: [msg, toolResult] };
  const append: ChatAppendParams = { id: "abc", messages: [msg] };
  const rename: ChatRenameParams = { id: "abc", title: "New title" };
  for (const shape of [create, createResult, list, get, append, rename]) {
    expect(JSON.parse(JSON.stringify(shape))).toEqual(shape);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/messages.test.ts`
Expected: FAIL — `ChatMessage` etc. are not exported from `./messages`.

- [ ] **Step 3: Add the interfaces**

Append to `packages/protocol/src/messages.ts`:

```ts
export interface ChatToolCall { id: string; name: string; args: unknown }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
}
export interface ChatSessionSummary { id: string; title: string; updatedAt: number; messageCount: number }

export interface ChatCreateParams { title?: string }
export interface ChatCreateResult { id: string }
export interface ChatListResult { sessions: ChatSessionSummary[] }
export interface ChatGetParams { id: string }
export interface ChatGetResult { id: string; title: string; messages: ChatMessage[] }
export interface ChatAppendParams { id: string; messages: ChatMessage[] }
export interface ChatRenameParams { id: string; title: string }
export interface ChatDeleteParams { id: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/src/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add chat/* message types"
```

---

### Task 2: Daemon — `SessionStore`

**Files:**
- Create: `packages/daemon/src/sessions.ts`
- Create: `packages/daemon/src/sessions.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `@zero/protocol` (Task 1); `Workspace` (`root` getter) from `./workspace.ts`.
- Produces: `SessionStore` class with `create(title?): Promise<string>`, `list(): Promise<ChatSessionSummary[]>`, `get(id): Promise<{ id: string; title: string; messages: ChatMessage[] } | null>`, `append(id, messages): Promise<void>`, `rename(id, title): Promise<void>`, `delete(id): Promise<void>`; `InvalidSessionIdError` — consumed by Task 3.

Session ids are always server-generated UUIDs (`create()` returns one), but `get`/`append`/`rename`/`delete` take a caller-supplied `id`. Unlike `Workspace`, which guards every path through `#resolveReal`, `SessionStore` builds its path directly from `id` — so `id` must be validated as UUID-shaped before touching the filesystem, or a crafted id like `../../etc/passwd` becomes a path-traversal write.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/sessions.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { SessionStore, InvalidSessionIdError } from "./sessions";

function makeStore(): SessionStore {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  return new SessionStore(new Workspace(root));
}

test("create then get round-trips an empty session", async () => {
  const store = makeStore();
  const id = await store.create("My chat");
  const session = await store.get(id);
  expect(session).toEqual({ id, title: "My chat", messages: [] });
});

test("create defaults the title", async () => {
  const store = makeStore();
  const id = await store.create();
  expect((await store.get(id))?.title).toBe("New chat");
});

test("append replaces the stored message list (compaction shrinks history)", async () => {
  const store = makeStore();
  const id = await store.create();
  await store.append(id, [{ role: "user", content: "hi", createdAt: 1 }]);
  await store.append(id, [{ role: "system", content: "summary", createdAt: 2 }]); // compaction: shrinks, doesn't grow
  expect((await store.get(id))?.messages).toEqual([{ role: "system", content: "summary", createdAt: 2 }]);
});

test("list sorts by most recently updated and reports message counts", async () => {
  const store = makeStore();
  const first = await store.create("First");
  await new Promise((r) => setTimeout(r, 5));
  const second = await store.create("Second");
  await store.append(first, [{ role: "user", content: "a", createdAt: 1 }, { role: "assistant", content: "b", createdAt: 2 }]);
  const list = await store.list();
  expect(list.map((s) => s.id)).toEqual([first, second]);
  expect(list.find((s) => s.id === first)?.messageCount).toBe(2);
});

test("rename updates the title without touching messages", async () => {
  const store = makeStore();
  const id = await store.create("Old");
  await store.append(id, [{ role: "user", content: "hi", createdAt: 1 }]);
  await store.rename(id, "New");
  expect(await store.get(id)).toEqual({ id, title: "New", messages: [{ role: "user", content: "hi", createdAt: 1 }] });
});

test("delete removes the session file", async () => {
  const store = makeStore();
  const id = await store.create();
  await store.delete(id);
  expect(await store.get(id)).toBeNull();
  expect(await store.list()).toEqual([]);
});

test("get/append/rename/delete reject non-UUID ids to block path traversal", async () => {
  const store = makeStore();
  await expect(store.get("../../etc/passwd")).rejects.toThrow(InvalidSessionIdError);
  await expect(store.append("../../etc/passwd", [])).rejects.toThrow(InvalidSessionIdError);
  await expect(store.rename("../../etc/passwd", "x")).rejects.toThrow(InvalidSessionIdError);
  await expect(store.delete("../../etc/passwd")).rejects.toThrow(InvalidSessionIdError);
});

test("list on a workspace with no sessions yet returns empty, not an error", async () => {
  const store = makeStore();
  expect(await store.list()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/sessions.test.ts`
Expected: FAIL — `./sessions` does not exist.

- [ ] **Step 3: Implement `SessionStore`**

Create `packages/daemon/src/sessions.ts`:

```ts
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatSessionSummary } from "@zero/protocol";
import type { Workspace } from "./workspace";

export class InvalidSessionIdError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredSession { id: string; title: string; updatedAt: number; messages: ChatMessage[] }

export class SessionStore {
  constructor(private workspace: Workspace) {}

  #dir(): string {
    return join(this.workspace.root, ".zero", "sessions");
  }

  #path(id: string): string {
    if (!UUID_RE.test(id)) throw new InvalidSessionIdError(id);
    return join(this.#dir(), `${id}.json`);
  }

  async #read(id: string): Promise<StoredSession | null> {
    try {
      return JSON.parse(await fs.readFile(this.#path(id), "utf8")) as StoredSession;
    } catch {
      return null;
    }
  }

  async #write(session: StoredSession): Promise<void> {
    await fs.mkdir(this.#dir(), { recursive: true });
    await fs.writeFile(this.#path(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  async create(title?: string): Promise<string> {
    const id = randomUUID();
    await this.#write({ id, title: title ?? "New chat", updatedAt: Date.now(), messages: [] });
    return id;
  }

  async list(): Promise<ChatSessionSummary[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.#dir());
    } catch {
      return [];
    }
    const sessions = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => this.#read(f.slice(0, -".json".length))),
    );
    return sessions
      .filter((s): s is StoredSession => s !== null)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<{ id: string; title: string; messages: ChatMessage[] } | null> {
    const s = await this.#read(id);
    return s && { id: s.id, title: s.title, messages: s.messages };
  }

  /** The caller (AgentRuntime, via chat/append) always sends the full,
   * authoritative message list for the session — compaction shrinks
   * history, so this replaces rather than truly appends. The store stays a
   * dumb persistence layer with no opinion on that. */
  async append(id: string, messages: ChatMessage[]): Promise<void> {
    const existing = await this.#read(id);
    await this.#write({ id, title: existing?.title ?? "New chat", updatedAt: Date.now(), messages });
  }

  async rename(id: string, title: string): Promise<void> {
    const existing = await this.#read(id);
    if (!existing) return;
    await this.#write({ ...existing, title });
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.#path(id));
    } catch {
      // already gone
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/sessions.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/sessions.ts packages/daemon/src/sessions.test.ts
git commit -m "feat(daemon): add file-backed SessionStore for chat sessions"
```

---

### Task 3: Daemon — wire `chat/*` RPCs

**Files:**
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Consumes: `SessionStore` (Task 2).
- Produces: `chat/create`, `chat/list`, `chat/get`, `chat/append`, `chat/rename`, `chat/delete` RPCs — consumed by Task 8 (`AgentRuntime`) and Task 10/11 (web chat panel).

- [ ] **Step 1: Write the failing test**

Append to `packages/daemon/src/main.test.ts` (reuses the `wsAdapter` helper already defined at the top of that file):

```ts
test("chat/* RPCs over the wire", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const { id } = await client.request<{ id: string }>("chat/create", { title: "Test chat" });
  expect((await client.request<{ sessions: { id: string; title: string }[] }>("chat/list")).sessions)
    .toEqual([{ id, title: "Test chat", updatedAt: expect.any(Number), messageCount: 0 }]);

  await client.request("chat/append", { id, messages: [{ role: "user", content: "hi", createdAt: 1 }] });
  expect(await client.request("chat/get", { id })).toEqual({
    id, title: "Test chat", messages: [{ role: "user", content: "hi", createdAt: 1 }],
  });

  await client.request("chat/rename", { id, title: "Renamed" });
  expect((await client.request<{ title: string }>("chat/get", { id })).title).toBe("Renamed");

  await client.request("chat/delete", { id });
  expect((await client.request<{ sessions: unknown[] }>("chat/list")).sessions).toEqual([]);

  ws.close(); d.stop();
});
```

(`expect.any` is a `bun:test` matcher already used implicitly elsewhere in this style of test; if unavailable in this Bun version, replace with a manual `typeof` check — but confirm the actual Bun version's support before doing so rather than assuming.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: FAIL — `unknown method chat/create`.

- [ ] **Step 3: Register the RPCs**

In `packages/daemon/src/main.ts`, add the import and construct the store alongside `Workspace`:

```ts
import { SessionStore } from "./sessions";
```

```ts
  const ws = new Workspace(opts.root);
  const sessions = new SessionStore(ws);
```

Then, near the other RPC registrations (after the `lsp/*` block, before the Graphify/plugin-host block), register:

```ts
  const chatToolCall = z.object({ id: z.string(), name: z.string(), args: z.unknown() });
  const chatMessage = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCalls: z.array(chatToolCall).optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    createdAt: z.number(),
  });
  daemon.rpc.register("chat/create", z.object({ title: z.string().optional() }),
    async (p) => ({ id: await sessions.create(p.title) }));
  daemon.rpc.register("chat/list", z.object({}).optional().transform(() => ({})),
    async () => ({ sessions: await sessions.list() }));
  daemon.rpc.register("chat/get", z.object({ id: z.string() }),
    async (p) => {
      const s = await sessions.get(p.id);
      if (!s) throw new Error(`no such session: ${p.id}`);
      return s;
    });
  daemon.rpc.register("chat/append", z.object({ id: z.string(), messages: z.array(chatMessage) }),
    async (p) => { await sessions.append(p.id, p.messages); return {}; });
  daemon.rpc.register("chat/rename", z.object({ id: z.string(), title: z.string() }),
    async (p) => { await sessions.rename(p.id, p.title); return {}; });
  daemon.rpc.register("chat/delete", z.object({ id: z.string() }),
    async (p) => { await sessions.delete(p.id); return {}; });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/main.ts packages/daemon/src/main.test.ts
git commit -m "feat(daemon): register chat/* RPCs backed by SessionStore"
```

---

### Task 4: Core — chat types and `ToolProvider`

**Files:**
- Create: `packages/core/src/chatTypes.ts`

**Interfaces:**
- Produces: `ChatToolCall`, `ChatMessage`, `ChatToolSpec`, `ChatDelta`, `ChatCapableProvider`, `ToolProvider` — consumed by Tasks 5–9.

Pure type declarations, matching `packages/core/src/types.ts`'s untested precedent — no test file for this task. `ChatMessage` here is structurally identical to `@zero/protocol`'s `ChatMessage` (Task 1) but independently declared, per the "core never imports protocol" convention `GraphContext`/`LspContext` already establish.

- [ ] **Step 1: Create the file**

Create `packages/core/src/chatTypes.ts`:

```ts
import type { ModelCapabilities, ModelProvider } from "./types";

export interface ChatToolCall { id: string; name: string; args: unknown }

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
}

export interface ChatToolSpec { name: string; description: string; schema: object }
export interface ChatDelta { text?: string; toolCalls?: ChatToolCall[] }

export interface ChatCapableProvider extends ModelProvider {
  chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta>;
  supportsTools(): boolean;
}

export interface ToolProvider {
  name: string;
  description: string;
  schema: object;
  execute(args: unknown): Promise<string>;
}

// Re-exported for callers that only need capability shapes, matching how
// types.ts re-exports ModelCapabilities alongside ModelProvider.
export type { ModelCapabilities };
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (file has no consumers yet, but must compile standalone)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/chatTypes.ts
git commit -m "feat(core): add chat message, tool, and chat-capable-provider types"
```

---

### Task 5: Core — token ledger and compaction

**Files:**
- Create: `packages/core/src/tokenLedger.ts`
- Create: `packages/core/src/tokenLedger.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` (`./tokens.ts`); `ChatMessage` (Task 4).
- Produces: `TOOL_OUTPUT_CHAR_CAP`, `COMPACTION_THRESHOLD_RATIO`, `KEEP_RECENT_EXCHANGES`, `COMPACTION_SYSTEM_PROMPT`, `capToolOutput(text): string`, `estimateMessagesTokens(messages): number`, `needsCompaction(history, contextWindowTokens): boolean`, `selectForCompaction(history, keepRecent?): { toSummarize: ChatMessage[]; toKeep: ChatMessage[] }` — consumed by Task 8 (`AgentRuntime`).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/tokenLedger.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  capToolOutput, estimateMessagesTokens, needsCompaction, selectForCompaction,
  TOOL_OUTPUT_CHAR_CAP, KEEP_RECENT_EXCHANGES,
} from "./tokenLedger";
import type { ChatMessage } from "./chatTypes";

test("capToolOutput leaves short output untouched", () => {
  expect(capToolOutput("short")).toBe("short");
});

test("capToolOutput truncates and marks long output", () => {
  const long = "x".repeat(TOOL_OUTPUT_CHAR_CAP + 500);
  const capped = capToolOutput(long);
  expect(capped.length).toBe(TOOL_OUTPUT_CHAR_CAP + "\n...[truncated]".length);
  expect(capped.startsWith("x".repeat(TOOL_OUTPUT_CHAR_CAP))).toBe(true);
  expect(capped.endsWith("...[truncated]")).toBe(true);
});

function msg(content: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return { role, content, createdAt: 0 };
}

test("estimateMessagesTokens sums per-message estimates (chars/4, rounded up)", () => {
  expect(estimateMessagesTokens([msg("abcd"), msg("abcdefgh")])).toBe(1 + 2);
});

test("needsCompaction is false comfortably under the 90% threshold", () => {
  const history = [msg("a".repeat(40))]; // 10 tokens
  expect(needsCompaction(history, 1000)).toBe(false);
});

test("needsCompaction is true once usage exceeds 90% of the budget", () => {
  const history = [msg("a".repeat(4000))]; // 1000 tokens
  expect(needsCompaction(history, 1000)).toBe(true); // 1000 > 900
  expect(needsCompaction(history, 2000)).toBe(false); // 1000 <= 1800
});

test("selectForCompaction keeps everything when there aren't more than keepRecent exchanges", () => {
  const history = [msg("hi", "user"), msg("hello", "assistant")];
  expect(selectForCompaction(history)).toEqual({ toSummarize: [], toKeep: history });
});

test("selectForCompaction splits at the boundary keeping the last N user-started exchanges", () => {
  // 6 user messages; default keepRecent is 4, so the split falls right before the 3rd-from-last user message.
  const history: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    history.push(msg(`q${i}`, "user"));
    history.push(msg(`a${i}`, "assistant"));
  }
  const { toSummarize, toKeep } = selectForCompaction(history);
  expect(toSummarize).toEqual(history.slice(0, 4)); // q0,a0,q1,a1
  expect(toKeep).toEqual(history.slice(4)); // q2..a5
  expect(toKeep.length).toBe(KEEP_RECENT_EXCHANGES * 2);
});

test("selectForCompaction with a custom keepRecent", () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 3; i++) { history.push(msg(`q${i}`, "user")); history.push(msg(`a${i}`, "assistant")); }
  const { toSummarize, toKeep } = selectForCompaction(history, 1);
  expect(toSummarize).toEqual(history.slice(0, 4));
  expect(toKeep).toEqual(history.slice(4));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/tokenLedger.test.ts`
Expected: FAIL — `./tokenLedger` does not exist.

- [ ] **Step 3: Implement**

Create `packages/core/src/tokenLedger.ts`:

```ts
import { estimateTokens } from "./tokens";
import type { ChatMessage } from "./chatTypes";

export const TOOL_OUTPUT_CHAR_CAP = 4000;
export const COMPACTION_THRESHOLD_RATIO = 0.9;
export const KEEP_RECENT_EXCHANGES = 4;

export const COMPACTION_SYSTEM_PROMPT = `Summarize the conversation so far for the assistant's own future reference.
Use exactly these Markdown headings, omitting any with nothing to report:
## Goal
## Constraints
## Done
## In Progress
## Key Decisions
## Relevant Files
## Next Steps
Preserve exact file paths, commands, error strings, and identifiers. Omit
pleasantries and anything not needed to resume the task.`;

export function capToolOutput(text: string): string {
  return text.length <= TOOL_OUTPUT_CHAR_CAP ? text : text.slice(0, TOOL_OUTPUT_CHAR_CAP) + "\n...[truncated]";
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

export function needsCompaction(history: ChatMessage[], contextWindowTokens: number): boolean {
  return estimateMessagesTokens(history) > contextWindowTokens * COMPACTION_THRESHOLD_RATIO;
}

export function selectForCompaction(
  history: ChatMessage[],
  keepRecent = KEEP_RECENT_EXCHANGES,
): { toSummarize: ChatMessage[]; toKeep: ChatMessage[] } {
  const userIndexes: number[] = [];
  history.forEach((m, i) => { if (m.role === "user") userIndexes.push(i); });
  if (userIndexes.length <= keepRecent) return { toSummarize: [], toKeep: history };
  const splitAt = userIndexes[userIndexes.length - keepRecent]!;
  return { toSummarize: history.slice(0, splitAt), toKeep: history.slice(splitAt) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/tokenLedger.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tokenLedger.ts packages/core/src/tokenLedger.test.ts
git commit -m "feat(core): add tool-output capping and history compaction helpers"
```

---

### Task 6: Core — layered system prompt

**Files:**
- Create: `packages/core/src/systemPrompt.ts`
- Create: `packages/core/src/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `ToolProvider` (Task 4).
- Produces: `WorkspaceInfo`, `buildSystemPrompt(opts: { tools: ToolProvider[]; workspace: WorkspaceInfo }): string` — consumed by Task 8 (`AgentRuntime`).

`WorkspaceInfo` is deliberately just `{ activeFile?: string }`: `@zero/web` (the only caller, Task 9) has no notion of a filesystem root or a detected language today — `Workbench`'s context only tracks `activePath`. Adding those would mean inventing new detection logic out of scope for M4.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/systemPrompt.test.ts`:

```ts
import { expect, test } from "bun:test";
import { buildSystemPrompt } from "./systemPrompt";
import type { ToolProvider } from "./chatTypes";

function tool(name: string, description: string): ToolProvider {
  return { name, description, schema: {}, execute: async () => "" };
}

test("lists each tool's name and description", () => {
  const prompt = buildSystemPrompt({
    tools: [tool("fs_read", "Read a file by path."), tool("graph_query", "Query the codebase graph.")],
    workspace: {},
  });
  expect(prompt).toContain("fs_read: Read a file by path.");
  expect(prompt).toContain("graph_query: Query the codebase graph.");
});

test("says so explicitly when there are no tools", () => {
  const prompt = buildSystemPrompt({ tools: [], workspace: {} });
  expect(prompt).toContain("no tools available");
});

test("includes the active file when present, omits it when absent", () => {
  const withFile = buildSystemPrompt({ tools: [], workspace: { activeFile: "src/app.ts" } });
  expect(withFile).toContain("Active file: src/app.ts");

  const withoutFile = buildSystemPrompt({ tools: [], workspace: {} });
  expect(withoutFile).not.toContain("Active file:");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/systemPrompt.test.ts`
Expected: FAIL — `./systemPrompt` does not exist.

- [ ] **Step 3: Implement**

Create `packages/core/src/systemPrompt.ts`:

```ts
import type { ToolProvider } from "./chatTypes";

export interface WorkspaceInfo { activeFile?: string }

const BASE_LAYER = `You are Zero, an offline coding assistant embedded in the user's editor.
Answer concisely and precisely. When you need information about the user's
codebase, use the available tools instead of guessing. Only claim a file's
contents or a symbol's definition after reading it via a tool. Prefer plain
prose; use code blocks only for actual code or file contents.`;

export function buildSystemPrompt(opts: { tools: ToolProvider[]; workspace: WorkspaceInfo }): string {
  const toolLines = opts.tools.length
    ? opts.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
    : "(no tools available)";
  const workspaceLines = opts.workspace.activeFile ? `Active file: ${opts.workspace.activeFile}` : "";

  return [BASE_LAYER, "Available tools:", toolLines, workspaceLines].filter(Boolean).join("\n\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/systemPrompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/systemPrompt.ts packages/core/src/systemPrompt.test.ts
git commit -m "feat(core): add layered system prompt builder"
```

---

### Task 7: Core — chat-capable providers

**Files:**
- Modify: `packages/core/src/providers/openaiCompat.ts`
- Modify: `packages/core/src/providers/openaiCompat.test.ts`
- Modify: `packages/core/src/providers/chromeNano.ts`
- Modify: `packages/core/src/providers/chromeNano.test.ts`

**Interfaces:**
- Consumes: `ChatCapableProvider`, `ChatMessage`, `ChatToolSpec`, `ChatDelta` (Task 4).
- Produces: `OpenAICompatProvider implements ChatCapableProvider`, `ChromeNanoProvider implements ChatCapableProvider` — consumed by Task 8 (`AgentRuntime`) and Task 9 (web `chatSetup.ts`).

Tool-call arguments in OpenAI-compatible streaming responses arrive as accumulating JSON-string fragments across SSE chunks; reassembling that incrementally adds real complexity for no UX gain here, since tool-call responses are short. `chat()` uses a single non-streaming request whenever `tools.length > 0`, and streams token-by-token (reusing the existing SSE-parsing shape from `complete()`) for plain conversation.

- [ ] **Step 1: Write the failing tests for `OpenAICompatProvider`**

Append to `packages/core/src/providers/openaiCompat.test.ts`:

```ts
import type { ChatToolSpec } from "../chatTypes";

test("chat() streams plain text via SSE when no tools are offered", async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ]),
  });
  let out = "";
  for await (const delta of provider.chat([{ role: "user", content: "hi", createdAt: 0 }], [], new AbortController().signal)) {
    if (delta.text) out += delta.text;
  }
  expect(out).toBe("hello");
});

test("chat() makes a single non-streaming request and returns tool calls when tools are offered", async () => {
  let capturedBody: { stream?: boolean; tools?: unknown } | undefined;
  const provider = new OpenAICompatProvider({
    baseUrl: "http://x/v1", model: "qwen",
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "fs_read", arguments: '{"path":"a.ts"}' } }] } }],
      }), { status: 200 });
    },
  });
  const tools: ChatToolSpec[] = [{ name: "fs_read", description: "Read a file.", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "read a.ts", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toEqual([{ text: undefined, toolCalls: [{ id: "c1", name: "fs_read", args: { path: "a.ts" } }] }]);
  expect(capturedBody?.stream).toBe(false);
  expect(capturedBody?.tools).toEqual([{ type: "function", function: { name: "fs_read", description: "Read a file.", parameters: { type: "object" } } }]);
});

test("supportsTools() is true", () => {
  const provider = new OpenAICompatProvider({ baseUrl: "http://x/v1", model: "qwen" });
  expect(provider.supportsTools()).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/providers/openaiCompat.test.ts`
Expected: FAIL — `provider.chat` is not a function.

- [ ] **Step 3: Implement `chat()` on `OpenAICompatProvider`**

In `packages/core/src/providers/openaiCompat.ts`, change the import and append the method inside the class:

```ts
import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";
```

```ts
export class OpenAICompatProvider implements ChatCapableProvider {
```

Add at the end of the class body (after `complete()`):

```ts
  supportsTools(): boolean {
    return true;
  }

  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    const body: Record<string, unknown> = {
      model: this.#opts.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      })),
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    }

    // Tool-call arguments stream as accumulating JSON-string fragments;
    // reassembling that incrementally isn't worth the complexity for
    // typically-short tool calls. Non-streaming whenever tools are offered;
    // stream plain text turns for responsiveness otherwise.
    if (tools.length) {
      const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/chat/completions`, {
        method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!res.ok) throw new Error(`chat failed: ${res.status}`);
      const data = await res.json() as {
        choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      const message = data.choices[0]?.message;
      const toolCalls = message?.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") }));
      yield { text: message?.content ?? undefined, toolCalls };
      return;
    }

    const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/chat/completions`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);
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
        const text = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (text) yield { text };
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/providers/openaiCompat.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for `ChromeNanoProvider`**

Append to `packages/core/src/providers/chromeNano.test.ts`:

```ts
test("chat() renders messages into a transcript and streams the session's response", async () => {
  let capturedPrompt = "";
  const api = {
    availability: async () => "available" as const,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string) { capturedPrompt = input; yield "Hi"; yield " there"; },
      destroy() {},
    }),
  };
  const provider = new ChromeNanoProvider(api);
  let out = "";
  for await (const delta of provider.chat(
    [{ role: "system", content: "Be helpful.", createdAt: 0 }, { role: "user", content: "hello", createdAt: 1 }],
    [], new AbortController().signal,
  )) {
    if (delta.text) out += delta.text;
  }
  expect(out).toBe("Hi there");
  expect(capturedPrompt).toContain("system: Be helpful.");
  expect(capturedPrompt).toContain("user: hello");
});

test("supportsTools() is false", () => {
  expect(new ChromeNanoProvider(undefined).supportsTools()).toBe(false);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `bun test packages/core/src/providers/chromeNano.test.ts`
Expected: FAIL — `provider.chat` is not a function.

- [ ] **Step 7: Implement `chat()` on `ChromeNanoProvider`**

In `packages/core/src/providers/chromeNano.ts`, change the import and class declaration:

```ts
import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";
```

```ts
export class ChromeNanoProvider implements ChatCapableProvider {
```

Add at the end of the class body:

```ts
  supportsTools(): boolean {
    return false;
  }

  async *chat(messages: ChatMessage[], _tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    if (!this.api) return;
    this.#session ??= await this.api.create();
    const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\nassistant:";
    for await (const chunk of this.#session.promptStreaming(transcript, { signal })) {
      if (signal.aborted) return;
      yield { text: chunk };
    }
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test packages/core/src/providers/chromeNano.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/providers/openaiCompat.ts packages/core/src/providers/openaiCompat.test.ts \
        packages/core/src/providers/chromeNano.ts packages/core/src/providers/chromeNano.test.ts
git commit -m "feat(core): add chat() to OpenAICompatProvider and ChromeNanoProvider"
```

---

### Task 8: Core — `AgentRuntime` turn loop

**Files:**
- Create: `packages/core/src/agentRuntime.ts`
- Create: `packages/core/src/agentRuntime.test.ts`

**Interfaces:**
- Consumes: `ChatCapableProvider`, `ChatMessage`, `ChatToolCall`, `ChatToolSpec`, `ToolProvider` (Task 4); `capToolOutput`, `needsCompaction`, `selectForCompaction`, `COMPACTION_SYSTEM_PROMPT` (Task 5); `buildSystemPrompt`, `WorkspaceInfo` (Task 6).
- Produces: `TurnEvent` (discriminated union: `text`, `toolCall`, `toolResult`, `done`), `AgentRuntimeClient`, `AgentRuntimeOpts`, `AgentRuntime` class with `sendMessage(sessionId, userText, signal): AsyncIterable<TurnEvent>`, `status(): { activeModel: string | null; reason: string | null }`, `onStatusChange(fn)` — consumed by Task 9 (web `chatSetup.ts`) and Task 11 (`ChatPanel`).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/agentRuntime.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/agentRuntime.test.ts`
Expected: FAIL — `./agentRuntime` does not exist.

- [ ] **Step 3: Implement `AgentRuntime`**

Create `packages/core/src/agentRuntime.ts`:

```ts
import type { ChatCapableProvider, ChatMessage, ChatToolCall, ChatToolSpec, ToolProvider } from "./chatTypes";
import { capToolOutput, needsCompaction, selectForCompaction, COMPACTION_SYSTEM_PROMPT } from "./tokenLedger";
import { buildSystemPrompt, type WorkspaceInfo } from "./systemPrompt";

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "toolResult"; call: ChatToolCall; result: string }
  | { type: "done"; message: ChatMessage };

export interface AgentRuntimeClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

export interface AgentRuntimeStatus { activeModel: string | null; reason: string | null }

export interface AgentRuntimeOpts {
  providers: ChatCapableProvider[];
  tools: ToolProvider[];
  client: AgentRuntimeClient;
  workspace: () => WorkspaceInfo;
}

const MAX_TOOL_ROUNDS = 8;

export class AgentRuntime {
  #providers: ChatCapableProvider[];
  #tools: ToolProvider[];
  #client: AgentRuntimeClient;
  #workspace: () => WorkspaceInfo;
  #status: AgentRuntimeStatus = { activeModel: null, reason: null };
  #listeners = new Set<(s: AgentRuntimeStatus) => void>();

  constructor(opts: AgentRuntimeOpts) {
    this.#providers = opts.providers;
    this.#tools = opts.tools;
    this.#client = opts.client;
    this.#workspace = opts.workspace;
  }

  status(): AgentRuntimeStatus {
    return this.#status;
  }

  onStatusChange(fn: (s: AgentRuntimeStatus) => void): void {
    this.#listeners.add(fn);
  }

  #setStatus(s: AgentRuntimeStatus): void {
    this.#status = s;
    for (const fn of this.#listeners) fn(s);
  }

  async #pick(): Promise<ChatCapableProvider | null> {
    for (const p of this.#providers) {
      if (await p.available().catch(() => false)) return p;
    }
    return null;
  }

  async *sendMessage(sessionId: string, userText: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
    const provider = await this.#pick();
    if (!provider) {
      this.#setStatus({ activeModel: null, reason: "no chat model available" });
      return;
    }
    this.#setStatus({ activeModel: provider.id, reason: null });

    const loaded = await this.#client.request<{ messages: ChatMessage[] }>("chat/get", { id: sessionId });
    let history = loaded.messages;

    if (needsCompaction(history, provider.capabilities().contextWindowTokens)) {
      history = await this.#compact(provider, history, signal);
    }
    if (signal.aborted) return;

    history = [...history, { role: "user", content: userText, createdAt: Date.now() }];
    const toolSpecs: ChatToolSpec[] = provider.supportsTools()
      ? this.#tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
      : [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const system: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({ tools: this.#tools, workspace: this.#workspace() }),
        createdAt: Date.now(),
      };
      let text = "";
      const toolCalls: ChatToolCall[] = [];
      for await (const delta of provider.chat([system, ...history], toolSpecs, signal)) {
        if (signal.aborted) return;
        if (delta.text) { text += delta.text; yield { type: "text", delta: delta.text }; }
        if (delta.toolCalls) toolCalls.push(...delta.toolCalls);
      }
      if (signal.aborted) return;

      const assistantMsg: ChatMessage = {
        role: "assistant", content: text, toolCalls: toolCalls.length ? toolCalls : undefined, createdAt: Date.now(),
      };
      history = [...history, assistantMsg];

      if (toolCalls.length === 0) {
        await this.#client.request("chat/append", { id: sessionId, messages: history });
        yield { type: "done", message: assistantMsg };
        return;
      }

      for (const call of toolCalls) {
        yield { type: "toolCall", call };
        const tool = this.#tools.find((t) => t.name === call.name);
        const rawResult = tool
          ? await tool.execute(call.args).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`)
          : `error: unknown tool ${call.name}`;
        const result = capToolOutput(rawResult);
        history = [...history, { role: "tool", content: result, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }];
        yield { type: "toolResult", call, result };
      }
    }

    await this.#client.request("chat/append", { id: sessionId, messages: history });
  }

  async #compact(provider: ChatCapableProvider, history: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
    const { toSummarize, toKeep } = selectForCompaction(history);
    if (toSummarize.length === 0) return history;

    const prompt: ChatMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT, createdAt: Date.now() },
      ...toSummarize,
      { role: "user", content: "Summarize the conversation above.", createdAt: Date.now() },
    ];
    let summary = "";
    for await (const delta of provider.chat(prompt, [], signal)) {
      if (delta.text) summary += delta.text;
    }
    return [{ role: "system", content: summary, createdAt: Date.now() }, ...toKeep];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/agentRuntime.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agentRuntime.ts packages/core/src/agentRuntime.test.ts
git commit -m "feat(core): add AgentRuntime turn loop with tool calling and compaction"
```

---

### Task 9: Core — export new symbols

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–8.
- Produces: public `@zero/core` surface consumed by Task 10/11 (`@zero/web`).

- [ ] **Step 1: Add exports**

Append to `packages/core/src/index.ts`:

```ts
export type {
  ChatToolCall, ChatMessage, ChatToolSpec, ChatDelta, ChatCapableProvider, ToolProvider,
} from "./chatTypes";
export {
  capToolOutput, estimateMessagesTokens, needsCompaction, selectForCompaction,
  TOOL_OUTPUT_CHAR_CAP, COMPACTION_THRESHOLD_RATIO, KEEP_RECENT_EXCHANGES, COMPACTION_SYSTEM_PROMPT,
} from "./tokenLedger";
export { buildSystemPrompt, type WorkspaceInfo } from "./systemPrompt";
export {
  AgentRuntime, type TurnEvent, type AgentRuntimeClient, type AgentRuntimeOpts, type AgentRuntimeStatus,
} from "./agentRuntime";
```

- [ ] **Step 2: Typecheck and run the full core test suite**

Run: `bun run typecheck && bun test packages/core`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export chat, token-ledger, system-prompt, and AgentRuntime APIs"
```

---

### Task 10: Web — daemon-backed chat tools and `AgentRuntime` wiring

**Files:**
- Create: `packages/web/src/chatTools.ts`
- Create: `packages/web/src/chatSetup.ts`

**Interfaces:**
- Consumes: `RpcClient` (`@zero/protocol`); `AgentRuntime`, `ChromeNanoProvider`, `OpenAICompatProvider`, `ToolProvider`, `NanoApi` (`@zero/core`).
- Produces: `createChatTools(client): ToolProvider[]`, `createChat(client, activeFile): AgentRuntime` — consumed by Task 11 (`Workbench.tsx`).

No dedicated test file: this mirrors `completionSetup.ts`, which is thin wiring over already-tested pieces (`OpenAICompatProvider.chat`, `ChromeNanoProvider.chat`, `AgentRuntime` from Task 7/8; the daemon RPCs from Task 3) and has no test of its own either.

- [ ] **Step 1: Implement `chatTools.ts`**

Create `packages/web/src/chatTools.ts`:

```ts
import type { ToolProvider } from "@zero/core";
import type { RpcClient } from "@zero/protocol";

function tool(name: string, description: string, schema: object, execute: (args: never) => Promise<string>): ToolProvider {
  return { name, description, schema, execute: execute as (args: unknown) => Promise<string> };
}

export function createChatTools(client: RpcClient): ToolProvider[] {
  return [
    tool(
      "fs_read", "Read a file's contents by workspace-relative path.",
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async (args: { path: string }) => (await client.request<{ content: string }>("fs/read", { path: args.path })).content,
    ),
    tool(
      "fs_tree", "List all files and directories in the workspace.",
      { type: "object", properties: {} },
      async () => JSON.stringify((await client.request<{ entries: { path: string; kind: string }[] }>("fs/tree")).entries),
    ),
    tool(
      "fs_search", "Search file contents for a literal query string.",
      { type: "object", properties: { query: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] },
      async (args: { query: string; caseSensitive?: boolean }) => JSON.stringify(await client.request("fs/search", args)),
    ),
    tool(
      "graph_query", "Query the codebase knowledge graph for symbols, neighbors, or paths.",
      { type: "object", properties: { q: { type: "string" }, mode: { type: "string", enum: ["neighbors", "symbol", "path"] } }, required: ["q"] },
      async (args: { q: string; mode?: "neighbors" | "symbol" | "path" }) =>
        (await client.request<{ text: string }>("graph/query", args)).text,
    ),
    tool(
      "lsp_hover", "Get type/hover information at a file position (0-based line and character).",
      { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      async (args: { path: string; line: number; character: number }) =>
        (await client.request<{ contents: string | null }>("lsp/hover", { path: args.path, position: { line: args.line, character: args.character } })).contents
          ?? "no hover info",
    ),
    tool(
      "lsp_definition", "Find the definition location(s) of the symbol at a file position (0-based line and character).",
      { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      async (args: { path: string; line: number; character: number }) =>
        JSON.stringify(await client.request("lsp/definition", { path: args.path, position: { line: args.line, character: args.character } })),
    ),
  ];
}
```

- [ ] **Step 2: Implement `chatSetup.ts`**

Create `packages/web/src/chatSetup.ts`:

```ts
import { AgentRuntime, ChromeNanoProvider, OpenAICompatProvider, type NanoApi } from "@zero/core";
import type { RpcClient } from "@zero/protocol";
import { createChatTools } from "./chatTools";

export function createChat(client: RpcClient, activeFile: () => string | undefined): AgentRuntime {
  const nanoApi = (globalThis as { LanguageModel?: NanoApi }).LanguageModel;
  return new AgentRuntime({
    providers: [
      new ChromeNanoProvider(nanoApi),
      new OpenAICompatProvider({
        baseUrl: localStorage.getItem("zero.ollamaUrl") ?? "http://127.0.0.1:11434/v1",
        model: localStorage.getItem("zero.ollamaChatModel") ?? "qwen2.5-coder:7b",
      }),
    ],
    tools: createChatTools(client),
    client: { request: (method, params) => client.request(method, params) },
    workspace: () => ({ activeFile: activeFile() }),
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/chatTools.ts packages/web/src/chatSetup.ts
git commit -m "feat(web): wire daemon-backed chat tools and AgentRuntime"
```

---

### Task 11: Web — `ChatStore` and `ChatPanel`

**Files:**
- Create: `packages/web/src/workbench/chat/store.ts`
- Create: `packages/web/src/workbench/chat/store.test.ts`
- Create: `packages/web/src/workbench/chat/ChatPanel.tsx`

**Interfaces:**
- Consumes: `ChatSessionSummary` (`@zero/protocol`); `AgentRuntime`, `AgentRuntimeStatus`, `ChatMessage` (`@zero/core`); `RpcClient` (`@zero/protocol`).
- Produces: `ChatStore` class (`getSessions`, `getActiveId`, `setSessions`, `setActive`, `addSession`, `removeSession`, `touchSession`, `subscribe`); `ChatPanel` component (with an inline `ChatStatusPill` showing the active chat model, mirroring `StatusPill.tsx`) — consumed by Task 12 (`Workbench.tsx`).

`ChatStore` mirrors `PtyStore` (`packages/web/src/workbench/terminal/store.ts`) but only tracks session *metadata* — message state per session lives in `ChatPanel`'s local React state (fetched via `chat/get` on session switch, appended to as `AgentRuntime.sendMessage`'s async generator yields events), the same division `TerminalPanel`/`PtyStore` draw between session bookkeeping (store) and per-session content (component-local, in that case via `TerminalHost`).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/workbench/chat/store.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ChatStore } from "./store";

test("addSession makes it active; removeSession falls back to the next session", () => {
  const store = new ChatStore();
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  expect(store.getActiveId()).toBe("a");
  store.addSession({ id: "b", title: "B", updatedAt: 2, messageCount: 0 });
  expect(store.getActiveId()).toBe("b");
  store.removeSession("b");
  expect(store.getActiveId()).toBe("a");
  store.removeSession("a");
  expect(store.getActiveId()).toBeNull();
});

test("setSessions replaces the list and clears activeId if it no longer exists", () => {
  const store = new ChatStore();
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  store.setSessions([{ id: "b", title: "B", updatedAt: 2, messageCount: 0 }]);
  expect(store.getSessions()).toEqual([{ id: "b", title: "B", updatedAt: 2, messageCount: 0 }]);
  expect(store.getActiveId()).toBeNull();
});

test("touchSession updates title and bumps updatedAt without changing activeId", () => {
  const store = new ChatStore();
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  store.touchSession("a", "Renamed");
  expect(store.getSessions()[0]).toMatchObject({ id: "a", title: "Renamed" });
  expect(store.getActiveId()).toBe("a");
});

test("subscribe notifies on every mutation", () => {
  const store = new ChatStore();
  let notified = 0;
  store.subscribe(() => { notified++; });
  store.addSession({ id: "a", title: "A", updatedAt: 1, messageCount: 0 });
  store.setActive("a");
  store.touchSession("a");
  store.removeSession("a");
  expect(notified).toBe(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/src/workbench/chat/store.test.ts`
Expected: FAIL — `./store` does not exist.

- [ ] **Step 3: Implement `ChatStore`**

Create `packages/web/src/workbench/chat/store.ts`:

```ts
import type { ChatSessionSummary } from "@zero/protocol";

export class ChatStore {
  #sessions: ChatSessionSummary[] = [];
  #activeId: string | null = null;
  #listeners = new Set<() => void>();

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  getSessions(): ChatSessionSummary[] {
    return this.#sessions;
  }

  getActiveId(): string | null {
    return this.#activeId;
  }

  setSessions(sessions: ChatSessionSummary[]): void {
    this.#sessions = sessions;
    if (this.#activeId && !sessions.some((s) => s.id === this.#activeId)) this.#activeId = null;
    this.#notify();
  }

  setActive(id: string): void {
    if (!this.#sessions.some((s) => s.id === id)) return;
    this.#activeId = id;
    this.#notify();
  }

  addSession(session: ChatSessionSummary): void {
    this.#sessions = [session, ...this.#sessions];
    this.#activeId = session.id;
    this.#notify();
  }

  removeSession(id: string): void {
    const idx = this.#sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this.#sessions = this.#sessions.filter((s) => s.id !== id);
    if (this.#activeId === id) {
      this.#activeId = this.#sessions[idx]?.id ?? this.#sessions[idx - 1]?.id ?? null;
    }
    this.#notify();
  }

  touchSession(id: string, title?: string): void {
    this.#sessions = this.#sessions.map((s) => (s.id === id ? { ...s, title: title ?? s.title, updatedAt: Date.now() } : s));
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/src/workbench/chat/store.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Implement `ChatPanel`**

Create `packages/web/src/workbench/chat/ChatPanel.tsx`. The status pill follows `StatusPill.tsx` (`packages/web/src/StatusPill.tsx`): same dot-plus-label shape and CSS variables, driven by `AgentRuntime.status()`/`onStatusChange()` instead of `CompletionEngine`'s:

```tsx
import { useEffect, useRef, useState } from "react";
import type { RpcClient, ChatSessionSummary } from "@zero/protocol";
import type { AgentRuntime, AgentRuntimeStatus, ChatMessage } from "@zero/core";
import type { ChatStore } from "./store";

function ChatStatusPill(props: { runtime: AgentRuntime }) {
  const [status, setStatus] = useState<AgentRuntimeStatus>(() => props.runtime.status());
  useEffect(() => {
    setStatus(props.runtime.status());
    props.runtime.onStatusChange(setStatus);
  }, [props.runtime]);
  const active = status.activeModel !== null;
  return (
    <div
      title={status.reason ?? undefined}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 12,
        border: "1px solid var(--zero-border)", fontSize: 14, color: "var(--zero-statusbar-fg)",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: active ? "#2ecc71" : "#999", flexShrink: 0 }} />
      {status.activeModel ?? "no chat model"}
    </div>
  );
}

export function ChatPanel(props: { client: RpcClient; runtime: AgentRuntime; chatStore: ChatStore }) {
  const { client, runtime, chatStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => chatStore.subscribe(() => setVersion((v) => v + 1)), [chatStore]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sessions = chatStore.getSessions();
  const activeId = chatStore.getActiveId();

  useEffect(() => {
    client.request<{ sessions: ChatSessionSummary[] }>("chat/list").then((r) => chatStore.setSessions(r.sessions));
  }, [client, chatStore]);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    client.request<{ messages: ChatMessage[] }>("chat/get", { id: activeId }).then((r) => setMessages(r.messages));
  }, [client, activeId]);

  async function newSession(): Promise<void> {
    const { id } = await client.request<{ id: string }>("chat/create", {});
    chatStore.addSession({ id, title: "New chat", updatedAt: Date.now(), messageCount: 0 });
  }

  function closeSession(id: string): void {
    void client.request("chat/delete", { id });
    chatStore.removeSession(id);
  }

  async function send(): Promise<void> {
    if (!activeId || !input.trim() || busy) return;
    const text = input;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, createdAt: Date.now() }]);
    setStreaming("");
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      for await (const event of runtime.sendMessage(activeId, text, ctl.signal)) {
        if (event.type === "text") {
          setStreaming((s) => s + event.delta);
        } else if (event.type === "toolResult") {
          setMessages((m) => [...m, { role: "tool", content: event.result, toolName: event.call.name, createdAt: Date.now() }]);
        } else if (event.type === "done") {
          setMessages((m) => [...m, event.message]);
          setStreaming("");
        }
      }
    } finally {
      setBusy(false);
      chatStore.touchSession(activeId);
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}>
      <div className="zero-tabstrip" role="tablist">
        {sessions.map((s) => (
          <div key={s.id} className="zero-tab" role="tab" aria-selected={s.id === activeId} onClick={() => chatStore.setActive(s.id)}>
            <span>{s.title}</span>
            <button className="zero-tab-close" aria-label={`Close chat ${s.title}`}
              onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}>
              ×
            </button>
          </div>
        ))}
        <button aria-label="New chat" onClick={() => void newSession()} style={{ marginLeft: 4 }}>+</button>
        <div style={{ marginLeft: "auto", padding: "4px 8px" }}>
          <ChatStatusPill runtime={runtime} />
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}>
        {!activeId ? (
          <div style={{ padding: 16, opacity: 0.6 }}>No chat open</div>
        ) : (
          <>
            {messages.filter((m) => m.role !== "system").map((m, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <strong>{m.role === "tool" ? `tool:${m.toolName}` : m.role}</strong>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ))}
            {streaming && (
              <div style={{ marginBottom: 8 }}>
                <strong>assistant</strong>
                <div style={{ whiteSpace: "pre-wrap" }}>{streaming}</div>
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, padding: 8, borderTop: "1px solid var(--zero-border)" }}>
        <input
          style={{ flex: 1 }}
          value={input}
          disabled={!activeId || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={activeId ? "Ask Zero..." : "Open a chat to start"}
        />
        <button onClick={() => void send()} disabled={!activeId || busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/workbench/chat/store.ts packages/web/src/workbench/chat/store.test.ts \
        packages/web/src/workbench/chat/ChatPanel.tsx
git commit -m "feat(web): add ChatStore and ChatPanel"
```

---

### Task 12: Web — wire the chat panel into `Workbench`

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `createChat` (Task 10); `ChatStore`, `ChatPanel` (Task 11).
- Produces: `view.toggleChat` command, `chat` dockview panel — end-user-visible; no further consumers.

- [ ] **Step 1: Add imports**

In `packages/web/src/workbench/layout/Workbench.tsx`, alongside the existing terminal imports:

```ts
import { createChat } from "../../chatSetup";
import { ChatStore } from "../chat/store";
import { ChatPanel } from "../chat/ChatPanel";
```

- [ ] **Step 2: Add the panel id constant**

Next to `const TERMINAL_PANEL_ID = "terminal";`:

```ts
const CHAT_PANEL_ID = "chat";
```

- [ ] **Step 3: Add `chatStore` and `chatRuntime` to `WorkbenchContextValue`**

In the `WorkbenchContextValue` interface, next to `ptyStore: PtyStore;`:

```ts
  chatStore: ChatStore;
  chatRuntime: AgentRuntime;
```

Add the `AgentRuntime` type import at the top alongside the other `@zero/core`-derived imports already in this file (there is currently no direct `@zero/core` type import in `Workbench.tsx` — add one):

```ts
import type { AgentRuntime } from "@zero/core";
```

- [ ] **Step 4: Add the `BottomChatPanel` component and register it**

Next to `function BottomTerminalPanel()`:

```tsx
function BottomChatPanel() {
  const w = useWorkbench();
  return <ChatPanel client={w.client} runtime={w.chatRuntime} chatStore={w.chatStore} />;
}
```

Update the stable component map:

```ts
const DOCKVIEW_COMPONENTS = { sidebar: SidebarPanel, editor: EditorPanel, terminal: BottomTerminalPanel, chat: BottomChatPanel };
```

- [ ] **Step 5: Construct `chatStore` and `chatRuntime` in `Workbench`**

Next to `const ptyStore = useConst(() => new PtyStore());`:

```ts
  const chatStore = useConst(() => new ChatStore());
  const chatRuntime = useConst(() => createChat(client, () => activePathRef.current ?? undefined));
```

`activePathRef` does not exist yet — `Workbench` currently tracks the active path only as `activePath` in render state (see `WorkbenchContextValue.activePath`), which isn't safely readable from inside a `useConst` initializer that runs once. Add a ref that mirrors it:

```ts
  const activePathRef = useRef<string | null>(null);
```

...and keep it current wherever `activePath` is computed/set in the existing render body (find the `const activePath = ...` or equivalent state derivation already in this file and add, immediately after it):

```ts
  activePathRef.current = activePath;
```

- [ ] **Step 6: Add show/toggle actions**

In the `actions` object, next to `showTerminalPanel`/`toggleTerminal`:

```ts
    showChatPanel: () => {
      const api = dockApi.current;
      if (!api || api.getPanel(CHAT_PANEL_ID)) return;
      api.addPanel({
        id: CHAT_PANEL_ID, component: "chat", params: {},
        position: { direction: "below" },
        initialHeight: 320,
      });
    },
    toggleChat: () => {
      const api = dockApi.current;
      if (!api) return;
      const panel = api.getPanel(CHAT_PANEL_ID);
      if (panel) { api.removePanel(panel); return; }
      actionsRef.current.showChatPanel();
    },
```

- [ ] **Step 7: Register the command**

In the `commands` array, next to `view.toggleTerminal`:

```ts
      { id: "view.toggleChat", title: "Toggle Chat", run: () => actionsRef.current.toggleChat(), keybinding: "Control+Shift+KeyC" },
```

- [ ] **Step 8: Add both to `contextValue`**

In the `contextValue` object built at the end of `Workbench`, next to `ptyStore,`:

```ts
    chatStore,
    chatRuntime,
```

- [ ] **Step 9: Manually verify in the browser**

Run: `bun install && bun run --cwd packages/daemon dev &` (or however the project's existing dev flow starts the daemon — reuse whatever `bun run dev` / equivalent script this repo already has; do not invent a new one) then load the web client, open a workspace, press `Control+Shift+C`, confirm the chat panel opens, click "+" to create a session, type a message, and confirm either a streamed reply appears (if Ollama is running locally) or the panel stays usable with no crash when no chat model is available (per the "degrade only the failing subsystem" constraint). Also confirm the editor and terminal remain fully functional with the chat panel open.

- [ ] **Step 10: Run the full web test suite and typecheck**

Run: `bun test packages/web && bun run typecheck`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): wire ChatPanel into the workbench with a toggle command"
```

---

### Task 13: Docs and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the status section**

In `README.md`, change:

```md
M0–M3 are implemented on `main`:
```

to:

```md
M0–M4 are implemented on `main`:
```

and add, after the M3 bullet:

```md
- **M4** chat / AgentRuntime (turn loop, layered system prompt, session
  persistence, token ledger, pruning/compaction, read-only tool calling,
  chat panel) — completes v1 scope
```

Update the design-docs list:

```md
- [M3 design](docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md)
- [M4 design](docs/superpowers/specs/2026-08-06-m4-chat-agentruntime-design.md)
- [Plugins](docs/plugins.md)
```

And change the closing roadmap line from:

```md
See the roadmap in the design spec for what follows (chat/AgentRuntime, Zero
Agents, Zero Lite, Claude plugin, Zero IDE).
```

to:

```md
See the roadmap in the design spec for what follows (Zero Agents, Zero Lite,
Claude plugin, Zero IDE).
```

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS across all packages.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: mark M4 as implemented on main"
```
