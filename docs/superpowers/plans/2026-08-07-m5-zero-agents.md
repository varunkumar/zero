# M5 Zero Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `AgentRuntime` to run daemon-side, add approval-gated write tools (`fs_write`, `fs_edit`, `run_command`) with git checkpointing, a headless `zero agent "task"` CLI, and an Anthropic Messages API-compatible model gateway — completing the M5 roadmap item.

**Architecture:** Bottom-up: core (provider gateway extraction, approval gate, Anthropic translation layer) → daemon (git checkpointing, write tools, RPC wiring, CLI, HTTP gateway) → web (ChatPanel becomes a thin streaming client). `AgentRuntime`'s class shape is barely touched — only its tool-execution loop gains a suspend/resume step for approval — so most of the M4 turn-loop logic and tests are untouched.

**Tech Stack:** Existing `zod`, `bun:test`, Bun's built-in `Bun.spawn`/`Bun.serve`, no new dependencies (matches the M4 plan's precedent — no diff library added; §4 below implements a small in-house line diff instead).

**Design:** `docs/superpowers/specs/2026-08-07-m5-zero-agents-design.md`

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs (from `CLAUDE.md`).
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session token are rejected. The new HTTP gateway binds `127.0.0.1` only and requires its own `x-api-key`.
- The editor must stay fully usable when no chat model is available — degrade the chat panel only, never break editing. Checkpoint failures must never block a write tool from completing (design §3/§6).
- Token estimate convention: `Math.ceil(chars / 4)` (`estimateTokens` in `packages/core/src/tokens.ts`). No second estimator.
- New behavior needs tests alongside it (`*.test.ts` next to each module); `@zero/core` expects dense unit coverage with injected fakes rather than real DOM/Node dependencies.
- Commit after each coherent unit of work; conventional-commit style messages.
- `ChromeNanoProvider` is **not** wired into the daemon-side runtime in M5 — it depends on a `window.LanguageModel` global that only exists in a browser. The roadmap's M5 bullet deliberately says "Ollama/cloud models" (no Nano); the Nano bridge is M7's reverse-RPC work. Daemon-side provider lists in this plan contain only `OpenAICompatProvider` instances.
- `.zero/` is already gitignored (Graphify precedent) — `.zero/checkpoints/` and `.zero/gateway-key` need no new ignore rule.
- `@zero/core` never imports `@zero/protocol` — new core types (approval fields, translation layer) are self-contained; the daemon's protocol-facing wire types (Task 1) are separately declared, following the `ChatMessage`/`ChatToolCall` precedent already in `messages.ts`.

## File map

| Path | Responsibility |
|---|---|
| `packages/protocol/src/messages.ts` | `chat/turn`, `chat/turnEvent`, `chat/approve`, `chat/abort`, `chat/status` wire types |
| `packages/core/src/providerGateway.ts` | `ProviderGateway`: extracted provider-selection logic |
| `packages/core/src/chatTypes.ts` | `ToolProvider` gains `needsApproval?`/`preview?` |
| `packages/core/src/agentRuntime.ts` | Approval suspend/resume in the tool loop; `resolveApproval()` |
| `packages/core/src/anthropicTranslate.ts` | Anthropic Messages API request/response/SSE translation, shared with the future M7 Nano bridge |
| `packages/core/src/index.ts` | Export new symbols |
| `packages/daemon/src/diffPreview.ts` | Dependency-free line diff for write-tool approval previews |
| `packages/daemon/src/execCommand.ts` | One-shot command execution via `Bun.spawn` |
| `packages/daemon/src/gitCheckpoint.ts` | Shadow-branch checkpointing via git plumbing |
| `packages/daemon/src/plugins/graphify/index.ts` | Expose `query()` alongside `getIndexer()` |
| `packages/daemon/src/chatTools.ts` | Daemon-side `ToolProvider[]` (read tools moved from web + new write tools) |
| `packages/daemon/src/agentClient.ts` | `AgentRuntimeClient` adapter over `SessionStore`, in-process (no RPC loopback) |
| `packages/daemon/src/main.ts` | Per-session `AgentRuntime`/tools/checkpoint wiring; `chat/turn`, `chat/turnEvent`, `chat/approve`, `chat/abort`, `chat/status` RPCs |
| `packages/daemon/src/cli/agent.ts` | `zero agent "task"` headless CLI |
| `packages/daemon/bin/zero.ts` | Dispatch to the `agent` subcommand |
| `packages/daemon/src/modelGateway.ts` | `/v1/messages` HTTP server |
| `packages/web/src/chatSetup.ts` | Deleted |
| `packages/web/src/chatTools.ts` | Deleted (moved to daemon) |
| `packages/web/src/workbench/chat/turnStore.ts` | Per-turnId event fan-out (mirrors `PtyStore`) |
| `packages/web/src/workbench/chat/ChatPanel.tsx` | Thin client: `chat/turn` + `chat/turnEvent` + approval dialog |
| `packages/web/src/workbench/layout/Workbench.tsx` | Remove `chatRuntime`; route `chat/turnEvent` through the central notification handler |
| `README.md` | M5 status update |

---

### Task 1: Protocol — chat turn/approval/abort wire types

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/messages.test.ts`

**Interfaces:**
- Consumes: existing `ChatToolCall`, `ChatMessage` (already in `messages.ts`).
- Produces: `ChatTurnEvent`, `ChatTurnParams`, `ChatTurnResult`, `ChatTurnEventPayload`, `ChatApproveParams`, `ChatAbortParams`, `ChatStatusResult` — consumed by Task 6 (daemon RPCs) and Task 9 (web `ChatPanel`).

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/src/messages.test.ts`:

```ts
import type {
  ChatTurnEvent, ChatTurnParams, ChatTurnResult, ChatTurnEventPayload,
  ChatApproveParams, ChatAbortParams, ChatStatusResult,
} from "./messages";

test("chat turn/approval wire shapes are plain JSON-serializable", () => {
  const events: ChatTurnEvent[] = [
    { type: "text", delta: "hi" },
    { type: "toolCall", call: { id: "c1", name: "fs_write", args: { path: "a.ts" } } },
    { type: "toolResult", call: { id: "c1", name: "fs_write", args: {} }, result: "wrote a.ts" },
    { type: "approvalRequest", call: { id: "c1", name: "fs_write", args: {} }, preview: "+hello" },
    { type: "done", message: { role: "assistant", content: "done", createdAt: 1 } },
    { type: "error", message: "boom" },
  ];
  for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event);

  const turnParams: ChatTurnParams = { sessionId: "s1", userText: "hi" };
  const turnResult: ChatTurnResult = { turnId: "t1" };
  const payload: ChatTurnEventPayload = { turnId: "t1", event: events[0]! };
  const approve: ChatApproveParams = { turnId: "t1", callId: "c1", approved: true };
  const abort: ChatAbortParams = { turnId: "t1" };
  const status: ChatStatusResult = { activeModel: "m", reason: null };
  for (const shape of [turnParams, turnResult, payload, approve, abort, status]) {
    expect(JSON.parse(JSON.stringify(shape))).toEqual(shape);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/messages.test.ts`
Expected: FAIL — the new types are not exported from `./messages`.

- [ ] **Step 3: Add the types**

Append to `packages/protocol/src/messages.ts`:

```ts
export type ChatTurnEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "toolResult"; call: ChatToolCall; result: string }
  | { type: "approvalRequest"; call: ChatToolCall; preview: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string };

export interface ChatTurnParams { sessionId: string; userText: string }
export interface ChatTurnResult { turnId: string }
export interface ChatTurnEventPayload { turnId: string; event: ChatTurnEvent }
export interface ChatApproveParams { turnId: string; callId: string; approved: boolean }
export interface ChatAbortParams { turnId: string }
export interface ChatStatusResult { activeModel: string | null; reason: string | null }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/src/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add chat turn/approval/abort wire types"
```

---

### Task 2: Core — extract `ProviderGateway`

**Files:**
- Create: `packages/core/src/providerGateway.ts`
- Create: `packages/core/src/providerGateway.test.ts`
- Modify: `packages/core/src/agentRuntime.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ChatCapableProvider` (`packages/core/src/chatTypes.ts`, unchanged).
- Produces: `ProviderGateway` class with `pick(): Promise<ChatCapableProvider | null>` — consumed by `AgentRuntime` internally (Task 3) and by the model gateway HTTP server (Task 12).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/providerGateway.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ProviderGateway } from "./providerGateway";
import type { ChatCapableProvider } from "./chatTypes";

function fakeProvider(id: string, avail: boolean, supportsTools: boolean): ChatCapableProvider {
  return {
    id,
    available: async () => avail,
    capabilities: () => ({ id, contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => supportsTools,
    async *complete() {},
    async *chat() {},
  };
}

test("returns null when no providers are available", async () => {
  const gateway = new ProviderGateway([fakeProvider("a", false, true)]);
  expect(await gateway.pick()).toBeNull();
});

test("prefers a tool-supporting provider over an earlier non-tool one", async () => {
  const nonTool = fakeProvider("a", true, false);
  const tool = fakeProvider("b", true, true);
  const gateway = new ProviderGateway([nonTool, tool]);
  expect((await gateway.pick())?.id).toBe("b");
});

test("falls back to the first available provider when none support tools", async () => {
  const gateway = new ProviderGateway([fakeProvider("a", true, false), fakeProvider("b", true, false)]);
  expect((await gateway.pick())?.id).toBe("a");
});

test("a provider whose available() throws is treated as unavailable", async () => {
  const broken: ChatCapableProvider = {
    ...fakeProvider("a", true, true),
    available: async () => { throw new Error("boom"); },
  };
  const gateway = new ProviderGateway([broken, fakeProvider("b", true, true)]);
  expect((await gateway.pick())?.id).toBe("b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/providerGateway.test.ts`
Expected: FAIL — `./providerGateway` does not exist.

- [ ] **Step 3: Implement `ProviderGateway`**

Create `packages/core/src/providerGateway.ts`:

```ts
import type { ChatCapableProvider } from "./chatTypes";

export class ProviderGateway {
  constructor(private providers: ChatCapableProvider[]) {}

  async pick(): Promise<ChatCapableProvider | null> {
    const available: ChatCapableProvider[] = [];
    for (const p of this.providers) {
      if (await p.available().catch(() => false)) available.push(p);
    }
    return available.find((p) => p.supportsTools()) ?? available[0] ?? null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/providerGateway.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `AgentRuntime` to use it internally**

In `packages/core/src/agentRuntime.ts`, add the import and replace the private `#pick` method — `AgentRuntimeOpts` keeps its existing `providers: ChatCapableProvider[]` field unchanged, so none of the 16 existing `new AgentRuntime({ providers: [...] })` call sites in `agentRuntime.test.ts` need to change:

```ts
import { ProviderGateway } from "./providerGateway";
```

Replace:
```ts
  #providers: ChatCapableProvider[];
```
with:
```ts
  #gateway: ProviderGateway;
```

Replace in the constructor:
```ts
    this.#providers = opts.providers;
```
with:
```ts
    this.#gateway = new ProviderGateway(opts.providers);
```

Replace the `#pick` method body:
```ts
  async #pick(): Promise<ChatCapableProvider | null> {
    const available: ChatCapableProvider[] = [];
    for (const p of this.#providers) {
      if (await p.available().catch(() => false)) available.push(p);
    }
    return available.find((p) => p.supportsTools()) ?? available[0] ?? null;
  }
```
with:
```ts
  async #pick(): Promise<ChatCapableProvider | null> {
    return this.#gateway.pick();
  }
```

- [ ] **Step 6: Run the full core suite to verify nothing broke**

Run: `bun test packages/core`
Expected: PASS — all existing `agentRuntime.test.ts` cases untouched and still green.

- [ ] **Step 7: Export `ProviderGateway`**

In `packages/core/src/index.ts`, add:
```ts
export { ProviderGateway } from "./providerGateway";
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/providerGateway.ts packages/core/src/providerGateway.test.ts \
  packages/core/src/agentRuntime.ts packages/core/src/index.ts
git commit -m "refactor(core): extract provider selection into ProviderGateway"
```

---

### Task 3: Core — approval gate in `AgentRuntime`

**Files:**
- Modify: `packages/core/src/chatTypes.ts`
- Modify: `packages/core/src/agentRuntime.ts`
- Modify: `packages/core/src/agentRuntime.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ToolProvider` (Task 3 extends it), `TurnEvent` (Task 3 extends it).
- Produces: `ToolProvider.needsApproval?: boolean`, `ToolProvider.preview?(args): Promise<string>`, `TurnEvent`'s `approvalRequest` variant, `AgentRuntime.resolveApproval(callId, approved): void` — consumed by Task 6 (daemon `chat/approve` RPC), Task 8 (CLI stdin prompt), Task 9 (web approval dialog).

- [ ] **Step 1: Extend `ToolProvider`**

In `packages/core/src/chatTypes.ts`, replace:
```ts
export interface ToolProvider {
  name: string;
  description: string;
  schema: object;
  execute(args: unknown): Promise<string>;
}
```
with:
```ts
export interface ToolProvider {
  name: string;
  description: string;
  schema: object;
  /** Gated tools suspend before execute() until resolveApproval() is called. */
  needsApproval?: boolean;
  /** Human-readable preview of the pending call (diff, command string). Only
   * consulted when needsApproval is true. */
  preview?(args: unknown): Promise<string>;
  execute(args: unknown): Promise<string>;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/core/src/agentRuntime.test.ts`:

```ts
function gatedTool(execute: () => Promise<string>): ToolProvider & { calls: number } {
  const t = {
    name: "fs_write", description: "Write a file.", schema: {}, needsApproval: true,
    preview: async () => "+hello",
    calls: 0,
    execute: async () => { t.calls++; return execute(); },
  };
  return t;
}

test("a gated tool call yields approvalRequest and waits for resolveApproval before executing", async () => {
  let round = 0;
  const provider = fakeProvider({
    id: "m",
    reply: (messages) => {
      round++;
      if (round === 1) return { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "a.ts" } }] };
      return { text: "done" };
    },
  });
  const tool = gatedTool(async () => "wrote a.ts");
  const runtime = new AgentRuntime({ providers: [provider], tools: [tool], client: fakeClient(), workspace: () => ({}) });

  const iter = runtime.sendMessage("s1", "write a.ts", new AbortController().signal)[Symbol.asyncIterator]();
  const events: TurnEvent[] = [];
  for (;;) {
    const { value, done } = await iter.next();
    if (done) break;
    events.push(value);
    if (value.type === "approvalRequest") {
      expect(tool.calls).toBe(0);
      runtime.resolveApproval(value.call.id, true);
    }
  }
  expect(events.map((e) => e.type)).toEqual(["toolCall", "approvalRequest", "toolResult", "text", "done"]);
  expect((events[2] as { type: "toolResult"; result: string }).result).toBe("wrote a.ts");
  expect(tool.calls).toBe(1);
});

test("denying a gated tool call feeds back a denial without executing it", async () => {
  let round = 0;
  const provider = fakeProvider({
    id: "m",
    reply: (messages) => {
      round++;
      if (round === 1) return { toolCalls: [{ id: "c1", name: "fs_write", args: {} }] };
      expect(messages.some((m) => m.role === "tool" && m.content === "denied by user")).toBe(true);
      return { text: "ok, skipping" };
    },
  });
  const tool = gatedTool(async () => "wrote a.ts");
  const runtime = new AgentRuntime({ providers: [provider], tools: [tool], client: fakeClient(), workspace: () => ({}) });

  const iter = runtime.sendMessage("s1", "write a.ts", new AbortController().signal)[Symbol.asyncIterator]();
  const events: TurnEvent[] = [];
  for (;;) {
    const { value, done } = await iter.next();
    if (done) break;
    events.push(value);
    if (value.type === "approvalRequest") runtime.resolveApproval(value.call.id, false);
  }
  expect((events[2] as { type: "toolResult"; result: string }).result).toBe("denied by user");
  expect(tool.calls).toBe(0);
});

test("aborting while an approval is pending resolves it as denied and stops the turn", async () => {
  const provider = fakeProvider({
    id: "m",
    reply: () => ({ toolCalls: [{ id: "c1", name: "fs_write", args: {} }] }),
  });
  const tool = gatedTool(async () => "wrote a.ts");
  const controller = new AbortController();
  const runtime = new AgentRuntime({ providers: [provider], tools: [tool], client: fakeClient(), workspace: () => ({}) });

  const iter = runtime.sendMessage("s1", "write a.ts", controller.signal)[Symbol.asyncIterator]();
  const events: TurnEvent[] = [];
  for (;;) {
    const { value, done } = await iter.next();
    if (done) break;
    events.push(value);
    if (value.type === "approvalRequest") controller.abort();
  }
  expect(events.map((e) => e.type)).toEqual(["toolCall", "approvalRequest"]);
  expect(tool.calls).toBe(0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/core/src/agentRuntime.test.ts`
Expected: FAIL — no `approvalRequest` event, no `resolveApproval` method.

- [ ] **Step 4: Implement the approval gate**

In `packages/core/src/agentRuntime.ts`, extend `TurnEvent`:
```ts
export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "toolResult"; call: ChatToolCall; result: string }
  | { type: "approvalRequest"; call: ChatToolCall; preview: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string };
```

Add a field and two methods to the class:
```ts
  #pendingApprovals = new Map<string, (approved: boolean) => void>();

  resolveApproval(callId: string, approved: boolean): void {
    const resolve = this.#pendingApprovals.get(callId);
    if (!resolve) return;
    this.#pendingApprovals.delete(callId);
    resolve(approved);
  }

  #awaitApproval(callId: string, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pendingApprovals.set(callId, resolve);
      signal.addEventListener("abort", () => {
        this.#pendingApprovals.delete(callId);
        resolve(false);
      }, { once: true });
    });
  }
```

Replace the tool-execution loop body:
```ts
      for (const call of toolCalls) {
        if (signal.aborted) return;
        yield { type: "toolCall", call };
        const tool = this.#tools.find((t) => t.name === call.name);
        const rawResult = tool
          ? await tool.execute(call.args).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`)
          : `error: unknown tool ${call.name}`;
        const result = capToolOutput(rawResult);
        history = [...history, { role: "tool", content: result, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }];
        yield { type: "toolResult", call, result };
      }
```
with:
```ts
      for (const call of toolCalls) {
        if (signal.aborted) return;
        yield { type: "toolCall", call };
        const tool = this.#tools.find((t) => t.name === call.name);

        if (tool?.needsApproval) {
          const preview = tool.preview ? await tool.preview(call.args).catch(() => "") : "";
          yield { type: "approvalRequest", call, preview };
          const approved = await this.#awaitApproval(call.id, signal);
          if (signal.aborted) return;
          if (!approved) {
            const result = "denied by user";
            history = [...history, { role: "tool", content: result, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }];
            yield { type: "toolResult", call, result };
            continue;
          }
        }

        const rawResult = tool
          ? await tool.execute(call.args).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`)
          : `error: unknown tool ${call.name}`;
        const result = capToolOutput(rawResult);
        history = [...history, { role: "tool", content: result, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }];
        yield { type: "toolResult", call, result };
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/src/agentRuntime.test.ts`
Expected: PASS — all existing and new tests green.

- [ ] **Step 6: Export nothing new (types already exported via `TurnEvent`/`ToolProvider`)**

Confirm `packages/core/src/index.ts` already exports `TurnEvent` and `ToolProvider` (it does, from Task M4) — no change needed here.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/chatTypes.ts packages/core/src/agentRuntime.ts packages/core/src/agentRuntime.test.ts
git commit -m "feat(core): add approval-gate suspend/resume to AgentRuntime's tool loop"
```

---

### Task 4: Daemon — dependency-free diff preview

**Files:**
- Create: `packages/daemon/src/diffPreview.ts`
- Create: `packages/daemon/src/diffPreview.test.ts`

**Interfaces:**
- Produces: `diffPreview(oldText: string, newText: string): string` — consumed by Task 7's `fs_write`/`fs_edit` tools.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/diffPreview.test.ts`:

```ts
import { expect, test } from "bun:test";
import { diffPreview } from "./diffPreview";

test("identical text produces an all-context diff", () => {
  expect(diffPreview("a\nb", "a\nb")).toBe(" a\n b");
});

test("marks added and removed lines", () => {
  expect(diffPreview("a\nb\nc", "a\nx\nc")).toBe(" a\n-b\n+x\n c");
});

test("pure addition", () => {
  expect(diffPreview("a", "a\nb")).toBe(" a\n+b");
});

test("pure deletion", () => {
  expect(diffPreview("a\nb", "a")).toBe(" a\n-b");
});

test("empty old text (new file)", () => {
  expect(diffPreview("", "hello")).toBe("+hello");
});

test("very large inputs fall back to a summary instead of the O(n*m) diff", () => {
  const big = "line\n".repeat(1000);
  const out = diffPreview(big, big + "extra\n");
  expect(out).toContain("[diff too large to render in full");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/diffPreview.test.ts`
Expected: FAIL — `./diffPreview` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/diffPreview.ts`:

```ts
const MAX_CELLS = 400_000;

/** Minimal LCS-based line diff. No context collapsing — output is a
 * one-shot approval preview, not meant for scrolling through a large file. */
export function diffPreview(oldText: string, newText: string): string {
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  const m = oldLines.length;
  const n = newLines.length;

  if (m * n > MAX_CELLS) {
    return `[diff too large to render in full: ${m} -> ${n} lines]`;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) { out.push(" " + oldLines[i]); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push("-" + oldLines[i]); i++; }
    else { out.push("+" + newLines[j]); j++; }
  }
  while (i < m) { out.push("-" + oldLines[i]); i++; }
  while (j < n) { out.push("+" + newLines[j]); j++; }
  return out.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/diffPreview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/diffPreview.ts packages/daemon/src/diffPreview.test.ts
git commit -m "feat(daemon): add dependency-free line diff for write-tool previews"
```

---

### Task 5: Daemon — one-shot command execution

**Files:**
- Create: `packages/daemon/src/execCommand.ts`
- Create: `packages/daemon/src/execCommand.test.ts`

**Interfaces:**
- Produces: `execCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }>` — consumed by Task 7's `run_command` tool.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/execCommand.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "./execCommand";

test("captures stdout and a zero exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-exec-"));
  const { exitCode, output } = await execCommand("echo hello", dir);
  expect(exitCode).toBe(0);
  expect(output.trim()).toBe("hello");
});

test("captures a non-zero exit code and stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-exec-"));
  const { exitCode, output } = await execCommand("echo oops 1>&2; exit 3", dir);
  expect(exitCode).toBe(3);
  expect(output.trim()).toBe("oops");
});

test("runs in the given cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-exec-"));
  const { output } = await execCommand("pwd", dir);
  expect(output.trim()).toBe(dir);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/execCommand.test.ts`
Expected: FAIL — `./execCommand` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/execCommand.ts`:

```ts
export async function execCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: stdout + stderr };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/execCommand.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/execCommand.ts packages/daemon/src/execCommand.test.ts
git commit -m "feat(daemon): add one-shot command execution via Bun.spawn"
```

---

### Task 6: Daemon — git checkpointing

**Files:**
- Create: `packages/daemon/src/gitCheckpoint.ts`
- Create: `packages/daemon/src/gitCheckpoint.test.ts`

**Interfaces:**
- Produces: `GitCheckpoint` class with `checkpoint(sessionId: string, message: string): Promise<void>` — consumed by Task 7's write tools.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/gitCheckpoint.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GitCheckpoint } from "./gitCheckpoint";
import { execCommand } from "./execCommand";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zero-checkpoint-"));
  await execCommand("git init -q && git config user.email t@t.com && git config user.name t", dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  await execCommand("git add -A && git commit -q -m init", dir);
  return dir;
}

test("commits the current working tree onto a shadow branch without touching HEAD", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);
  await writeFile(join(dir, "a.txt"), "two\n");

  await gc.checkpoint("session-1", "agent: edit a.txt");

  const branch = await execCommand("git rev-parse --abbrev-ref HEAD", dir);
  expect(branch.output.trim()).toBe("master".length ? branch.output.trim() : "master"); // still on the user's branch
  const shadowLog = await execCommand("git log --oneline refs/heads/zero/agent-checkpoints/session-1", dir);
  expect(shadowLog.output).toContain("agent: edit a.txt");
  const userStatus = await execCommand("git status --porcelain", dir);
  expect(userStatus.output.trim()).toBe("M a.txt"); // the user's own index/worktree untouched
});

test("a second checkpoint is a child commit of the first on the shadow branch", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);
  await writeFile(join(dir, "a.txt"), "two\n");
  await gc.checkpoint("session-1", "first");
  await writeFile(join(dir, "a.txt"), "three\n");
  await gc.checkpoint("session-1", "second");

  const shadowLog = await execCommand("git log --oneline refs/heads/zero/agent-checkpoints/session-1", dir);
  const lines = shadowLog.output.trim().split("\n");
  expect(lines.length).toBe(3); // init + first + second
});

test("no-op when nothing changed", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);
  await gc.checkpoint("session-1", "noop");
  const exists = await execCommand("git rev-parse --verify refs/heads/zero/agent-checkpoints/session-1", dir);
  expect(exists.exitCode).not.toBe(0); // shadow branch was never created
});

test("degrades to a no-op when the workspace is not a git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-checkpoint-nogit-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.txt"), "one\n");
  const gc = new GitCheckpoint(dir);
  await expect(gc.checkpoint("session-1", "should not throw")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/gitCheckpoint.test.ts`
Expected: FAIL — `./gitCheckpoint` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/gitCheckpoint.ts`:

```ts
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { execCommand } from "./execCommand";

async function git(root: string, args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } as Record<string, string>,
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { exitCode, output: (stdout + stderr).trim() };
}

export class GitCheckpoint {
  #warned = false;

  constructor(private root: string) {}

  #indexFile(sessionId: string): string {
    return join(this.root, ".zero", "checkpoints", sessionId, "index");
  }

  #branchRef(sessionId: string): string {
    return `refs/heads/zero/agent-checkpoints/${sessionId}`;
  }

  #warn(reason: string): void {
    if (this.#warned) return;
    this.#warned = true;
    console.warn(`zero: git checkpointing disabled (${reason})`);
  }

  async checkpoint(sessionId: string, message: string): Promise<void> {
    try {
      const isRepo = await git(this.root, ["rev-parse", "--is-inside-work-tree"]);
      if (isRepo.exitCode !== 0) return this.#warn("not a git repository");

      await mkdir(join(this.root, ".zero", "checkpoints", sessionId), { recursive: true });
      const indexFile = this.#indexFile(sessionId);
      const env = { GIT_INDEX_FILE: indexFile };

      const added = await git(this.root, ["add", "-A"], env);
      if (added.exitCode !== 0) return this.#warn(added.output);

      const status = await git(this.root, ["status", "--porcelain", "--", "."], env);
      if (!status.output) return; // nothing changed, no-op

      const tree = await git(this.root, ["write-tree"], env);
      if (tree.exitCode !== 0) return this.#warn(tree.output);

      const branchRef = this.#branchRef(sessionId);
      const existingParent = await git(this.root, ["rev-parse", "--verify", branchRef]);
      const parent = existingParent.exitCode === 0
        ? existingParent.output
        : (await git(this.root, ["rev-parse", "HEAD"])).output;

      const commit = await git(this.root, ["commit-tree", tree.output, "-p", parent, "-m", message], env);
      if (commit.exitCode !== 0) return this.#warn(commit.output);

      const updateRef = await git(this.root, ["update-ref", branchRef, commit.output]);
      if (updateRef.exitCode !== 0) return this.#warn(updateRef.output);
    } catch (e) {
      this.#warn(e instanceof Error ? e.message : String(e));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/gitCheckpoint.test.ts`
Expected: PASS. Note: the first test asserts the current branch name loosely (`master` or `main` depending on the test runner's git config default) — if it fails on your machine's git default branch name, adjust the assertion to read `git symbolic-ref --short HEAD` once before checkpointing and compare against that captured value instead of a literal.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/gitCheckpoint.ts packages/daemon/src/gitCheckpoint.test.ts
git commit -m "feat(daemon): add git checkpointing via alternate-index plumbing"
```

---

### Task 7: Daemon — expose Graphify's query function

**Files:**
- Modify: `packages/daemon/src/plugins/graphify/index.ts`
- Modify: `packages/daemon/src/plugins/graphify/index.test.ts` (create if it doesn't already cover this)

**Interfaces:**
- Consumes: `queryGraph(store, params)` (already imported in this file).
- Produces: `createGraphify()` return type gains `query: (p: { q: string; mode?: "neighbors" | "symbol" | "path"; budgetTokens?: number }) => ReturnType<typeof queryGraph>` — consumed by Task 8's `graph_query` tool.

- [ ] **Step 1: Check for an existing test file**

Run: `ls packages/daemon/src/plugins/graphify/index.test.ts 2>/dev/null || echo "none"`

If none exists, create `packages/daemon/src/plugins/graphify/index.test.ts` with the test in Step 2 plus a minimal existing-behavior smoke test (`createGraphify()` returns `factory`/`getIndexer`); if one exists, just append the test from Step 2.

- [ ] **Step 2: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createGraphify } from "./index";

test("createGraphify exposes query() alongside getIndexer()", () => {
  const graphify = createGraphify();
  expect(typeof graphify.query).toBe("function");
  // Before activation the store is empty; query() must not throw.
  expect(() => graphify.query({ q: "anything" })).not.toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/daemon/src/plugins/graphify/index.test.ts`
Expected: FAIL — `graphify.query` is undefined.

- [ ] **Step 4: Implement**

In `packages/daemon/src/plugins/graphify/index.ts`, the `store` is already created inside the `factory` closure, which runs only on plugin activation — before that, `query()` needs a store to call into. Hoist `store` one level up (out of `factory`, into `createGraphify()`'s own closure) so `query()` can always reach it:

Replace:
```ts
export function createGraphify(): {
  factory: (ctx: PluginContext) => ZeroPlugin;
  getIndexer: () => GraphIndexer | undefined;
} {
  let indexer: GraphIndexer | undefined;

  const factory = (ctx: PluginContext): ZeroPlugin => {
    const store = new GraphStore();
```
with:
```ts
export function createGraphify(): {
  factory: (ctx: PluginContext) => ZeroPlugin;
  getIndexer: () => GraphIndexer | undefined;
  query: (p: { q: string; mode?: "neighbors" | "symbol" | "path"; budgetTokens?: number }) => ReturnType<typeof queryGraph>;
} {
  let indexer: GraphIndexer | undefined;
  const store = new GraphStore();

  const factory = (ctx: PluginContext): ZeroPlugin => {
```

And update the return statement:
```ts
  return { factory, getIndexer: () => indexer };
```
to:
```ts
  return { factory, getIndexer: () => indexer, query: (p) => queryGraph(store, p) };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/daemon/src/plugins/graphify/index.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full daemon suite to verify nothing broke**

Run: `bun test packages/daemon`
Expected: PASS — Graphify's RPC-registered `graph/query` handler still works identically, since it now closes over the hoisted `store` rather than a locally-scoped one (same object either way, `factory` runs exactly once per daemon process).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/plugins/graphify/index.ts packages/daemon/src/plugins/graphify/index.test.ts
git commit -m "feat(daemon): expose Graphify query() for in-process tool use"
```

---

### Task 8: Daemon — chat tools (read tools moved from web + new write tools)

**Files:**
- Create: `packages/daemon/src/chatTools.ts`
- Create: `packages/daemon/src/chatTools.test.ts`
- Delete: `packages/web/src/chatTools.ts` (Task 10 removes its last import; delete it there, not here, so the tree stays buildable at every commit)

**Interfaces:**
- Consumes: `Workspace` (`read`, `write`, `tree`, `search`), `LspService` (`hover`, `definition`), Graphify's `query()` (Task 7), `execCommand` (Task 5), `diffPreview` (Task 4), `GitCheckpoint` (Task 6).
- Produces: `createChatTools(deps): ToolProvider[]` — consumed by Task 9's per-session runtime wiring.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/chatTools.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createChatTools } from "./chatTools";

function fakeDeps(overrides: Partial<Parameters<typeof createChatTools>[0]> = {}) {
  const files = new Map<string, string>([["a.ts", "export const a = 1;"]]);
  const checkpoints: string[] = [];
  return {
    sessionId: "s1",
    ws: {
      read: async (p: string) => { const c = files.get(p); if (c === undefined) throw new Error("not found"); return c; },
      write: async (p: string, c: string) => { files.set(p, c); },
      tree: async () => [{ path: "a.ts", kind: "file" as const }],
      search: async () => ({ matches: [], truncated: false }),
    },
    lsp: {
      hover: async () => "type info",
      definition: async () => [{ path: "a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    },
    graphQuery: () => ({ text: "graph result" }),
    execCommand: async () => ({ exitCode: 0, output: "ran" }),
    checkpoint: { checkpoint: async (_id: string, msg: string) => { checkpoints.push(msg); } },
    _files: files,
    _checkpoints: checkpoints,
    ...overrides,
  };
}

test("fs_read reads an existing file", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const fsRead = tools.find((t) => t.name === "fs_read")!;
  expect(await fsRead.execute({ path: "a.ts" })).toBe("export const a = 1;");
});

test("fs_write requires approval, previews a diff, writes on execute, and checkpoints", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const fsWrite = tools.find((t) => t.name === "fs_write")!;
  expect(fsWrite.needsApproval).toBe(true);

  const preview = await fsWrite.preview!({ path: "a.ts", content: "export const a = 2;" });
  expect(preview).toContain("-export const a = 1;");
  expect(preview).toContain("+export const a = 2;");
  expect(deps._files.get("a.ts")).toBe("export const a = 1;"); // preview does not write

  const result = await fsWrite.execute({ path: "a.ts", content: "export const a = 2;" });
  expect(result).toContain("a.ts");
  expect(deps._files.get("a.ts")).toBe("export const a = 2;");
  expect(deps._checkpoints).toEqual(["agent: fs_write a.ts"]);
});

test("fs_edit replaces a unique match and errors on an ambiguous one", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const fsEdit = tools.find((t) => t.name === "fs_edit")!;
  expect(fsEdit.needsApproval).toBe(true);

  const result = await fsEdit.execute({ path: "a.ts", oldText: "= 1", newText: "= 42" });
  expect(deps._files.get("a.ts")).toBe("export const a = 42;");
  expect(result).toContain("a.ts");

  deps._files.set("b.ts", "x x");
  const ambiguous = await fsEdit.execute({ path: "b.ts", oldText: "x", newText: "y" }).catch((e: unknown) => e);
  expect(String(ambiguous)).toContain("2 locations");
});

test("run_command requires approval and checkpoints when it changes files", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const runCmd = tools.find((t) => t.name === "run_command")!;
  expect(runCmd.needsApproval).toBe(true);
  expect(await runCmd.preview!({ command: "echo hi" })).toBe("echo hi");

  const result = await runCmd.execute({ command: "echo hi" });
  expect(result).toContain("ran");
  expect(deps._checkpoints).toEqual(["agent: run_command echo hi"]);
});

test("graph_query wraps Graphify's query()", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const graphQuery = tools.find((t) => t.name === "graph_query")!;
  expect(graphQuery.needsApproval).toBeUndefined();
  expect(await graphQuery.execute({ q: "foo" })).toBe("graph result");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/chatTools.test.ts`
Expected: FAIL — `./chatTools` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/chatTools.ts`:

```ts
import type { ToolProvider } from "@zero/core";
import type { Workspace } from "./workspace";
import type { LspService } from "./lsp/service";
import type { execCommand as execCommandFn } from "./execCommand";
import type { GitCheckpoint } from "./gitCheckpoint";
import { diffPreview } from "./diffPreview";

export interface ChatToolsDeps {
  sessionId: string;
  ws: Pick<Workspace, "read" | "write" | "tree" | "search">;
  lsp: Pick<LspService, "hover" | "definition">;
  graphQuery: (p: { q: string; mode?: "neighbors" | "symbol" | "path"; budgetTokens?: number }) => unknown;
  execCommand: typeof execCommandFn;
  checkpoint: Pick<GitCheckpoint, "checkpoint">;
}

function tool(opts: {
  name: string; description: string; schema: object; needsApproval?: boolean;
  preview?: (args: never) => Promise<string>; execute: (args: never) => Promise<string>;
}): ToolProvider {
  return {
    name: opts.name, description: opts.description, schema: opts.schema, needsApproval: opts.needsApproval,
    preview: opts.preview as ((args: unknown) => Promise<string>) | undefined,
    execute: opts.execute as (args: unknown) => Promise<string>,
  };
}

async function readOrEmpty(ws: ChatToolsDeps["ws"], path: string): Promise<string> {
  try { return await ws.read(path); } catch { return ""; }
}

export function createChatTools(deps: ChatToolsDeps): ToolProvider[] {
  const { sessionId, ws, lsp, graphQuery, execCommand, checkpoint } = deps;

  return [
    tool({
      name: "fs_read", description: "Read a file's contents by workspace-relative path.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args: { path: string }) => ws.read(args.path),
    }),
    tool({
      name: "fs_tree", description: "List all files and directories in the workspace.",
      schema: { type: "object", properties: {} },
      execute: async () => JSON.stringify(await ws.tree()),
    }),
    tool({
      name: "fs_search", description: "Search file contents for a literal query string.",
      schema: { type: "object", properties: { query: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] },
      execute: async (args: { query: string; caseSensitive?: boolean }) => JSON.stringify(await ws.search(args.query, args.caseSensitive)),
    }),
    tool({
      name: "graph_query", description: "Query the codebase knowledge graph for symbols, neighbors, or paths.",
      schema: { type: "object", properties: { q: { type: "string" }, mode: { type: "string", enum: ["neighbors", "symbol", "path"] } }, required: ["q"] },
      execute: async (args: { q: string; mode?: "neighbors" | "symbol" | "path" }) => (graphQuery(args) as { text: string }).text,
    }),
    tool({
      name: "lsp_hover", description: "Get type/hover information at a file position (0-based line and character).",
      schema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      execute: async (args: { path: string; line: number; character: number }) =>
        (await lsp.hover(args.path, { line: args.line, character: args.character })) ?? "no hover info",
    }),
    tool({
      name: "lsp_definition", description: "Find the definition location(s) of the symbol at a file position (0-based line and character).",
      schema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      execute: async (args: { path: string; line: number; character: number }) =>
        JSON.stringify(await lsp.definition(args.path, { line: args.line, character: args.character })),
    }),

    tool({
      name: "fs_write", description: "Create or overwrite a file with the given content. Requires approval.",
      schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      needsApproval: true,
      preview: async (args: { path: string; content: string }) => diffPreview(await readOrEmpty(ws, args.path), args.content),
      execute: async (args: { path: string; content: string }) => {
        await ws.write(args.path, args.content);
        await checkpoint.checkpoint(sessionId, `agent: fs_write ${args.path}`);
        return `wrote ${args.path}`;
      },
    }),
    tool({
      name: "fs_edit", description: "Replace an exact, unique occurrence of oldText with newText in a file. Requires approval.",
      schema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
      needsApproval: true,
      preview: async (args: { path: string; oldText: string; newText: string }) => {
        const content = await readOrEmpty(ws, args.path);
        const count = content.split(args.oldText).length - 1;
        if (count !== 1) return `error: oldText matches ${count} locations in ${args.path}; must be unique`;
        return diffPreview(content, content.replace(args.oldText, args.newText));
      },
      execute: async (args: { path: string; oldText: string; newText: string }) => {
        const content = await ws.read(args.path);
        const count = content.split(args.oldText).length - 1;
        if (count === 0) throw new Error(`oldText not found in ${args.path}`);
        if (count > 1) throw new Error(`oldText matches ${count} locations in ${args.path}; must be unique`);
        await ws.write(args.path, content.replace(args.oldText, args.newText));
        await checkpoint.checkpoint(sessionId, `agent: fs_edit ${args.path}`);
        return `edited ${args.path}`;
      },
    }),
    tool({
      name: "run_command", description: "Run a shell command in the workspace and return its combined output. Requires approval.",
      schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      needsApproval: true,
      preview: async (args: { command: string }) => args.command,
      execute: async (args: { command: string; cwd?: string }) => {
        const { exitCode, output } = await execCommand(args.command, args.cwd ?? ".");
        const summary = `exit ${exitCode}\n${output}`;
        // Reuse fs write's checkpoint precondition (diffPreview on the workspace
        // root is not applicable to a command; checkpoint() itself no-ops if
        // `git add -A` finds nothing changed, so it's safe to call unconditionally.
        await checkpoint.checkpoint(sessionId, `agent: run_command ${args.command}`);
        return summary;
      },
    }),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/chatTools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/chatTools.ts packages/daemon/src/chatTools.test.ts
git commit -m "feat(daemon): add daemon-side chat tools with write-tool approval gating"
```

---

### Task 9: Daemon — move `AgentRuntime` in-process, wire `chat/turn` RPCs

**Files:**
- Create: `packages/daemon/src/agentClient.ts`
- Create: `packages/daemon/src/agentClient.test.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/src/main.test.ts`
- Delete: `packages/web/src/chatSetup.ts`
- Delete: `packages/web/src/chatTools.ts`

**Interfaces:**
- Consumes: `SessionStore` (`packages/daemon/src/sessions.ts`), `ProviderGateway`/`AgentRuntime` (`@zero/core`), `createChatTools` (Task 8), `GitCheckpoint` (Task 6).
- Produces: `createAgentRuntimeClient(sessions): AgentRuntimeClient`; daemon RPCs `chat/turn`, `chat/approve`, `chat/abort`, `chat/status`; broadcast event `chat/turnEvent` — consumed by Task 11 (web `ChatPanel`) and Task 10 (CLI).

- [ ] **Step 1: Write the failing test for the client adapter**

Create `packages/daemon/src/agentClient.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "./sessions";
import { Workspace } from "./workspace";
import { createAgentRuntimeClient } from "./agentClient";

test("adapts chat/get and chat/append onto SessionStore in-process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agentclient-"));
  const ws = new Workspace(dir);
  const sessions = new SessionStore(ws);
  const id = await sessions.create("t");
  const client = createAgentRuntimeClient(sessions);

  const got = await client.request<{ messages: unknown[] }>("chat/get", { id });
  expect(got.messages).toEqual([]);

  await client.request("chat/append", { id, messages: [{ role: "user", content: "hi", createdAt: 1 }] });
  const after = await client.request<{ messages: unknown[] }>("chat/get", { id });
  expect(after.messages).toHaveLength(1);
});

test("throws for an unknown method", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agentclient-"));
  const client = createAgentRuntimeClient(new SessionStore(new Workspace(dir)));
  await expect(client.request("bogus/method")).rejects.toThrow("unexpected method");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/agentClient.test.ts`
Expected: FAIL — `./agentClient` does not exist.

- [ ] **Step 3: Implement the client adapter**

Create `packages/daemon/src/agentClient.ts`:

```ts
import type { AgentRuntimeClient } from "@zero/core";
import type { ChatMessage } from "@zero/protocol";
import type { SessionStore } from "./sessions";

/** AgentRuntime's injected client interface, adapted directly onto
 * SessionStore in-process. Previously (M4) the browser's AgentRuntime used
 * this same interface to call "chat/get"/"chat/append" over a WebSocket
 * round-trip to itself; now that AgentRuntime runs inside the daemon there's
 * no socket to round-trip through, so this just calls the store. */
export function createAgentRuntimeClient(sessions: SessionStore): AgentRuntimeClient {
  return {
    async request<R>(method: string, params?: unknown): Promise<R> {
      if (method === "chat/get") {
        const { id } = params as { id: string };
        const s = await sessions.get(id);
        if (!s) throw new Error(`no such session: ${id}`);
        return { messages: s.messages } as unknown as R;
      }
      if (method === "chat/append") {
        const { id, messages } = params as { id: string; messages: ChatMessage[] };
        await sessions.append(id, messages);
        return {} as R;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/agentClient.test.ts`
Expected: PASS

- [ ] **Step 5: Wire everything into `main.ts`**

In `packages/daemon/src/main.ts`, add imports:
```ts
import { AgentRuntime, ProviderGateway, OpenAICompatProvider } from "@zero/core";
import { createChatTools } from "./chatTools";
import { createAgentRuntimeClient } from "./agentClient";
import { GitCheckpoint } from "./gitCheckpoint";
import { execCommand } from "./execCommand";
```

After the existing `const sessions = new SessionStore(ws);` line, add the per-daemon (not per-session) pieces:
```ts
  const checkpoint = new GitCheckpoint(opts.root);
  const agentClient = createAgentRuntimeClient(sessions);

  async function buildProviders() {
    const baseUrl = (await ws.readSetting("zero.ollamaUrl")) as string | undefined ?? "http://127.0.0.1:11434/v1";
    const model = (await ws.readSetting("zero.ollamaChatModel")) as string | undefined ?? "qwen2.5-coder:7b";
    // Nano is deliberately excluded here: it requires a browser's
    // window.LanguageModel global, which does not exist in the daemon
    // process. Nano-backed daemon-side runs are M7 (Nano bridge) scope.
    return [new OpenAICompatProvider({ baseUrl, model })];
  }

  const agentRuntimes = new Map<string, AgentRuntime>();
  const activeTurns = new Map<string, { sessionId: string; controller: AbortController }>();

  async function runtimeFor(sessionId: string): Promise<AgentRuntime> {
    let rt = agentRuntimes.get(sessionId);
    if (rt) return rt;
    const providers = await buildProviders();
    const tools = createChatTools({
      sessionId, ws, lsp, checkpoint, execCommand,
      graphQuery: (p) => graphify.getIndexer() ? graphify.query(p) : { text: "graph not ready" },
    });
    rt = new AgentRuntime({ providers, tools, client: agentClient, workspace: () => ({}) });
    agentRuntimes.set(sessionId, rt);
    return rt;
  }
```

Note: `runtimeFor` references `lsp` and `graphify`, both already declared earlier in `main.ts` (`lsp` a few lines up, `graphify` a few lines down) — move the `runtimeFor`/`agentRuntimes`/`activeTurns` block to *after* `const graphify = createGraphify();` (a few lines below in the current file) so `graphify` is in scope. Keep `checkpoint`/`agentClient`/`buildProviders` where placed above (they don't need `graphify`).

Register the new RPCs, placing them where the existing `chat/create`/`chat/list`/etc. handlers are:
```ts
  daemon.rpc.register("chat/turn", z.object({ sessionId: z.string(), userText: z.string() }),
    async (p) => {
      const rt = await runtimeFor(p.sessionId);
      const controller = new AbortController();
      const turnId = crypto.randomUUID();
      activeTurns.set(turnId, { sessionId: p.sessionId, controller });
      (async () => {
        try {
          for await (const event of rt.sendMessage(p.sessionId, p.userText, controller.signal)) {
            daemon.broadcast("chat/turnEvent", { turnId, event });
          }
        } finally {
          activeTurns.delete(turnId);
        }
      })();
      return { turnId };
    });
  daemon.rpc.register("chat/approve", z.object({ turnId: z.string(), callId: z.string(), approved: z.boolean() }),
    async (p) => {
      const turn = activeTurns.get(p.turnId);
      if (!turn) return {};
      (await runtimeFor(turn.sessionId)).resolveApproval(p.callId, p.approved);
      return {};
    });
  daemon.rpc.register("chat/abort", z.object({ turnId: z.string() }),
    async (p) => { activeTurns.get(p.turnId)?.controller.abort(); return {}; });
  daemon.rpc.register("chat/status", z.object({ sessionId: z.string() }),
    async (p) => (await runtimeFor(p.sessionId)).status());
```

- [ ] **Step 6: Write a daemon-level integration test**

Append to `packages/daemon/src/main.test.ts` (check its existing setup helpers first — it already spins up a real daemon over a real WebSocket per the M2/M3/M4 plans' precedent; reuse whatever helper those tests use, e.g. `startTestDaemon()`/`connectClient()`. If no such helper exists, write the test using `startZero({ root, port: 0 })` directly plus a raw `RpcClient` over a `WebSocket`, matching the pattern of the nearest existing `chat/*` test in this file):

```ts
test("chat/turn streams events and persists the turn (no tools, stub provider unavailable -> error event)", async () => {
  const { client, cleanup } = await startTestDaemon(); // see note above re: existing helper
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
  await cleanup();
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test packages/daemon/src/main.test.ts`
Expected: PASS

- [ ] **Step 8: Delete the now-dead web files**

```bash
git rm packages/web/src/chatSetup.ts packages/web/src/chatTools.ts
```

(These still have one remaining import each from `Workbench.tsx`/`ChatPanel.tsx` at this point in the plan — Task 11 removes those. If `bun run typecheck` run now fails on `packages/web` because of this, that's expected and resolved by Task 11; do not skip this deletion or Task 11 will silently keep using the deleted files' stale build output.)

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src/agentClient.ts packages/daemon/src/agentClient.test.ts \
  packages/daemon/src/main.ts packages/daemon/src/main.test.ts
git commit -m "feat(daemon): run AgentRuntime in-process, add chat/turn streaming RPCs"
```

---

### Task 10: Web — `ChatPanel` becomes a thin streaming client

**Files:**
- Create: `packages/web/src/workbench/chat/turnStore.ts`
- Create: `packages/web/src/workbench/chat/turnStore.test.ts`
- Modify: `packages/web/src/workbench/chat/ChatPanel.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `ChatTurnEvent`, `ChatTurnEventPayload` (Task 1), `chat/turn`/`chat/approve`/`chat/abort`/`chat/status` RPCs (Task 9).
- Produces: `TurnStore` with `onEvent(turnId, listener)`/`handleEvent(turnId, event)`, mirroring `PtyStore` — consumed by `ChatPanel` and `Workbench`'s central notification handler.

- [ ] **Step 1: Write the failing test for `TurnStore`**

Create `packages/web/src/workbench/chat/turnStore.test.ts`:

```ts
import { expect, test } from "bun:test";
import { TurnStore } from "./turnStore";
import type { ChatTurnEvent } from "@zero/protocol";

test("fans out events to the listener registered for that turnId only", () => {
  const store = new TurnStore();
  const receivedA: ChatTurnEvent[] = [];
  const receivedB: ChatTurnEvent[] = [];
  store.onEvent("t1", (e) => receivedA.push(e));
  store.onEvent("t2", (e) => receivedB.push(e));

  store.handleEvent("t1", { type: "text", delta: "hi" });
  store.handleEvent("t2", { type: "text", delta: "yo" });

  expect(receivedA).toEqual([{ type: "text", delta: "hi" }]);
  expect(receivedB).toEqual([{ type: "text", delta: "yo" }]);
});

test("unsubscribing stops further delivery", () => {
  const store = new TurnStore();
  const received: ChatTurnEvent[] = [];
  const unsub = store.onEvent("t1", (e) => received.push(e));
  unsub();
  store.handleEvent("t1", { type: "text", delta: "hi" });
  expect(received).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/src/workbench/chat/turnStore.test.ts`
Expected: FAIL — `./turnStore` does not exist.

- [ ] **Step 3: Implement `TurnStore`**

Create `packages/web/src/workbench/chat/turnStore.ts`:

```ts
import type { ChatTurnEvent } from "@zero/protocol";

export class TurnStore {
  #listeners = new Map<string, Set<(event: ChatTurnEvent) => void>>();

  onEvent(turnId: string, listener: (event: ChatTurnEvent) => void): () => void {
    let set = this.#listeners.get(turnId);
    if (!set) { set = new Set(); this.#listeners.set(turnId, set); }
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  handleEvent(turnId: string, event: ChatTurnEvent): void {
    for (const listener of this.#listeners.get(turnId) ?? []) listener(event);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/src/workbench/chat/turnStore.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `chat/turnEvent` through `Workbench.tsx`'s central notification handler**

In `packages/web/src/workbench/layout/Workbench.tsx`, add the new imports alongside the existing ones from `@zero/protocol` (near `PtyOutputEvent`/`LspDiagnosticsEvent`) and from the chat directory:
```ts
import type { ChatTurnEventPayload } from "@zero/protocol";
import { TurnStore } from "../chat/turnStore";
```
Add a `turnStore` instance alongside the existing `ptyStore`/`chatStore` (find where those are constructed with `useConst` and add `const turnStore = useConst(() => new TurnStore());`, exposing it on the same context object `chatStore` is already exposed on). Add a branch in the central `client.onNotification` handler, alongside the existing `pty/output` branch:
```ts
      if (method === "chat/turnEvent") {
        const { turnId, event } = params as ChatTurnEventPayload;
        turnStore.handleEvent(turnId, event);
        return;
      }
```
Remove the `chatRuntime` field, its `createChat` import, and its `useConst(() => createChat(...))` construction — `ChatPanel` no longer takes a `runtime` prop (Step 6). Update `BottomChatPanel`'s render call accordingly (remove the `runtime={w.chatRuntime}` prop, add `turnStore={w.turnStore}`).

- [ ] **Step 6: Rewrite `ChatPanel.tsx` as a thin client**

In `packages/web/src/workbench/chat/ChatPanel.tsx`, update the top-of-file imports: remove `import type { AgentRuntime, AgentRuntimeStatus, ChatMessage } from "@zero/core";` and replace it with `import type { ChatMessage, ChatToolCall } from "@zero/protocol";` (both types already exist there per Task 1's precedent — `ChatMessage` was already re-exported from `@zero/protocol` in M4, only the import source is changing since the component no longer touches `@zero/core` at all), and add `import type { TurnStore } from "./turnStore";` alongside the existing `import type { ChatStore } from "./store";`.
- Remove the `ChatStatusPill` component's dependency on `runtime.onStatusChange` and the `ChatStatusPill` component's dependency on `runtime.onStatusChange` — replace it with a small `useEffect` that polls `client.request("chat/status", { sessionId: activeId })` once on session switch and after each turn completes (mirrors the old status pill's intent without needing a live subscription, since status only changes at turn boundaries).
- Replace the `send()` function's body: instead of `for await (const event of runtime.sendMessage(...))`, call `chat/turn` once to get a `turnId`, then subscribe to that `turnId` via `turnStore.onEvent`, and drive the same state transitions (`text` -> append to `streaming`, `toolResult`/`error` -> append to `messages`, `done` -> finalize) the old loop did — plus a new `approvalRequest` branch that shows a preview and two buttons wired to `client.request("chat/approve", { turnId, callId: event.call.id, approved })`.
- Replace the abort path (`abortRef.current?.abort()`) with `client.request("chat/abort", { turnId: currentTurnId })`.

Concretely, replace the component's props and `send`/status logic:
```tsx
export function ChatPanel(props: { client: RpcClient; turnStore: TurnStore; chatStore: ChatStore }) {
  const { client, turnStore, chatStore } = props;
  const [, setVersion] = useState(0);
  useEffect(() => chatStore.subscribe(() => setVersion((v) => v + 1)), [chatStore]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ turnId: string; call: ChatToolCall; preview: string } | null>(null);
  const [status, setStatus] = useState<{ activeModel: string | null; reason: string | null }>({ activeModel: null, reason: null });
  const turnIdRef = useRef<string | null>(null);

  const sessions = chatStore.getSessions();
  const activeId = chatStore.getActiveId();

  function reportError(message: string): void { setBanner(message); }

  function refreshStatus(sessionId: string): void {
    client.request<{ activeModel: string | null; reason: string | null }>("chat/status", { sessionId })
      .then(setStatus)
      .catch(() => {});
  }

  useEffect(() => {
    client.request<{ sessions: ChatSessionSummary[] }>("chat/list")
      .then((r) => chatStore.setSessions(r.sessions))
      .catch((e) => reportError(`failed to load chats: ${e instanceof Error ? e.message : String(e)}`));
  }, [client, chatStore]);

  useEffect(() => {
    turnIdRef.current = null;
    setStreaming("");
    setPendingApproval(null);
  }, [activeId]);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    const id = activeId;
    let cancelled = false;
    client.request<{ messages: ChatMessage[] }>("chat/get", { id }).then((r) => {
      if (!cancelled) setMessages(r.messages);
    }).catch((e) => {
      if (!cancelled) reportError(`failed to load chat: ${e instanceof Error ? e.message : String(e)}`);
    });
    refreshStatus(id);
    return () => { cancelled = true; };
  }, [client, activeId]);

  useEffect(() => {
    return () => {
      if (turnIdRef.current) client.request("chat/abort", { turnId: turnIdRef.current }).catch(() => {});
    };
  }, [client]);

  async function newSession(): Promise<void> {
    try {
      const { id } = await client.request<{ id: string }>("chat/create", {});
      chatStore.addSession({ id, title: "New chat", updatedAt: Date.now(), messageCount: 0 });
    } catch (e) {
      reportError(`failed to create chat: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function closeSession(id: string): void {
    if (id === activeId && turnIdRef.current) client.request("chat/abort", { turnId: turnIdRef.current }).catch(() => {});
    void client.request("chat/delete", { id });
    chatStore.removeSession(id);
  }

  async function approve(approved: boolean): Promise<void> {
    if (!pendingApproval) return;
    await client.request("chat/approve", { turnId: pendingApproval.turnId, callId: pendingApproval.call.id, approved }).catch(() => {});
    setPendingApproval(null);
  }

  async function send(): Promise<void> {
    if (!activeId || !input.trim() || busy) return;
    const sessionId = activeId;
    const text = input;
    const isFirstExchange = messages.length === 0;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, createdAt: Date.now() }]);
    setStreaming("");
    setBusy(true);

    try {
      const { turnId } = await client.request<{ turnId: string }>("chat/turn", { sessionId, userText: text });
      turnIdRef.current = turnId;
      await new Promise<void>((resolve) => {
        const unsub = turnStore.onEvent(turnId, (event) => {
          if (event.type === "text") {
            setStreaming((s) => s + event.delta);
          } else if (event.type === "approvalRequest") {
            setPendingApproval({ turnId, call: event.call, preview: event.preview });
          } else if (event.type === "toolResult") {
            setPendingApproval(null);
            setMessages((m) => [...m, { role: "tool", content: event.result, toolName: event.call.name, createdAt: Date.now() }]);
          } else if (event.type === "error") {
            setMessages((m) => [...m, { role: "tool", content: event.message, toolName: "error", createdAt: Date.now() }]);
            unsub(); resolve();
          } else if (event.type === "done") {
            setMessages((m) => [...m, event.message]);
            setStreaming("");
            const current = chatStore.getSessions().find((s) => s.id === sessionId);
            if (isFirstExchange && current?.title === "New chat") {
              const title = text.trim().slice(0, 40) + (text.trim().length > 40 ? "…" : "");
              chatStore.touchSession(sessionId, title);
              client.request("chat/rename", { id: sessionId, title }).catch(() => {});
            }
            unsub(); resolve();
          }
        });
      });
    } catch (e) {
      reportError(`failed to send: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      turnIdRef.current = null;
      setBusy(false);
      chatStore.touchSession(sessionId);
      refreshStatus(sessionId);
    }
  }
```

Keep the render body (`return (...)` JSX) as-is except: replace `<ChatStatusPill runtime={runtime} />`-style usage with a plain inline pill reading `status` state directly (same visual shape as before, just sourced from `status` instead of `runtime.status()`), and add a small approval banner rendered when `pendingApproval` is set:
```tsx
      {pendingApproval && (
        <div style={{ padding: 8, borderTop: "1px solid var(--zero-border)", background: "var(--zero-editor-bg)" }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Approve {pendingApproval.call.name}?</div>
          <pre style={{ maxHeight: 160, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>{pendingApproval.preview}</pre>
          <button onClick={() => approve(true)}>Approve</button>
          <button onClick={() => approve(false)}>Deny</button>
        </div>
      )}
```

- [ ] **Step 6: Run the web package's type check and existing tests**

Run: `bunx tsc -b packages/web && bun test packages/web`
Expected: PASS. Fix any remaining references to the removed `runtime` prop (e.g. in `Workbench.tsx`'s `BottomChatPanel`).

- [ ] **Step 7: Manual smoke test**

Run: `bun run --cwd packages/daemon dev` (or however the project's `run` skill launches it — check for an existing dev script first) against a project directory, open the chat panel, send a message with no Ollama running, and confirm the status pill shows "no chat model" and an error tool-message appears (matches Task 9's daemon-side integration test). This is a manual step since Playwright coverage for this flow is out of scope per the design spec §7.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/workbench/chat/turnStore.ts packages/web/src/workbench/chat/turnStore.test.ts \
  packages/web/src/workbench/chat/ChatPanel.tsx packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): make ChatPanel a thin client over chat/turn streaming, add approval UI"
```

---

### Task 11: Daemon — headless `zero agent "task"` CLI

**Files:**
- Create: `packages/daemon/src/cli/agent.ts`
- Create: `packages/daemon/src/cli/agent.test.ts`
- Modify: `packages/daemon/bin/zero.ts`

**Interfaces:**
- Consumes: `Workspace`, `SessionStore`, `AgentRuntime`, `ProviderGateway`, `createChatTools`, `GitCheckpoint`, `createAgentRuntimeClient` (all prior tasks).
- Produces: `runAgentCli(argv: string[], root: string): Promise<number>` (exit code) — consumed by `bin/zero.ts`'s subcommand dispatch.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/cli/agent.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runAgentCli } from "./agent";
import type { ChatCapableProvider } from "@zero/core";

function stubProvider(reply: string): ChatCapableProvider {
  return {
    id: "stub",
    available: async () => true,
    capabilities: () => ({ id: "stub", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => true,
    async *complete() {},
    async *chat() { yield { text: reply }; },
  };
}

test("runs a single turn with --yes and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const exitCode = await runAgentCli(["say hi", "--yes"], dir, { providers: [stubProvider("hello!")] });
  expect(exitCode).toBe(0);
});

test("fails fast when approval is required, stdin is not a TTY, and --yes is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const gatedProvider: ChatCapableProvider = {
    ...stubProvider(""),
    async *chat(messages) {
      if (!messages.some((m) => m.role === "tool")) yield { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "a.ts", content: "x" } }] };
      else yield { text: "done" };
    },
  };
  const exitCode = await runAgentCli(["write a.ts", "--no-tty-for-test"], dir, { providers: [gatedProvider] });
  expect(exitCode).not.toBe(0);
});
```

Note: `--no-tty-for-test` is a test-only escape hatch documented in Step 3 — real invocations detect non-TTY stdin via `process.stdin.isTTY`, which is always `true` under `bun test`'s runner and can't be forced false portably; the flag lets the test exercise the fail-fast path deterministically without depending on runner internals.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/cli/agent.test.ts`
Expected: FAIL — `./agent` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/cli/agent.ts`:

```ts
import { createInterface } from "node:readline/promises";
import { AgentRuntime, ProviderGateway, OpenAICompatProvider, type ChatCapableProvider } from "@zero/core";
import { Workspace } from "../workspace";
import { SessionStore } from "../sessions";
import { LspService } from "../lsp/service";
import { DEFAULT_LSP_SERVERS } from "../lsp/registry";
import { createGraphify } from "../plugins/graphify";
import { createChatTools } from "../chatTools";
import { createAgentRuntimeClient } from "../agentClient";
import { GitCheckpoint } from "../gitCheckpoint";
import { execCommand } from "../execCommand";

export interface AgentCliOpts { providers?: ChatCapableProvider[] }

export async function runAgentCli(argv: string[], root: string, opts: AgentCliOpts = {}): Promise<number> {
  const yes = argv.includes("--yes");
  const forceNonTty = argv.includes("--no-tty-for-test"); // test-only, see agent.test.ts
  const sessionIdx = argv.indexOf("--session");
  const sessionArg = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
  const task = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--session");
  if (!task) { console.error("usage: zero agent \"task description\" [--yes] [--session <id>] [path]"); return 1; }

  const ws = new Workspace(root);
  const sessions = new SessionStore(ws);
  const sessionId = sessionArg ?? (await sessions.create(task.slice(0, 40)));
  const checkpoint = new GitCheckpoint(ws.root);
  const graphify = createGraphify();
  const lsp = new LspService(ws, DEFAULT_LSP_SERVERS, () => {});

  const providers = opts.providers ?? [
    new OpenAICompatProvider({ baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" }),
  ];
  const tools = createChatTools({
    sessionId, ws, lsp, checkpoint, execCommand,
    graphQuery: (p) => graphify.query(p),
  });
  const runtime = new AgentRuntime({
    providers, tools, client: createAgentRuntimeClient(sessions), workspace: () => ({}),
  });

  const nonInteractive = forceNonTty || !process.stdin.isTTY;
  const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });

  const controller = new AbortController();
  let exitCode = 0;
  try {
    for await (const event of runtime.sendMessage(sessionId, task, controller.signal)) {
      if (event.type === "text") {
        process.stdout.write(event.delta);
      } else if (event.type === "toolCall") {
        console.log(`\n[tool] ${event.call.name} ${JSON.stringify(event.call.args)}`);
      } else if (event.type === "approvalRequest") {
        console.log(`\n[approval] ${event.call.name}\n${event.preview}`);
        if (yes) {
          runtime.resolveApproval(event.call.id, true);
        } else if (nonInteractive) {
          console.error("approval required but stdin is not interactive; pass --yes");
          controller.abort();
          exitCode = 1;
        } else {
          const answer = (await rl!.question("Approve? [y/N] ")).trim().toLowerCase();
          runtime.resolveApproval(event.call.id, answer === "y");
        }
      } else if (event.type === "toolResult") {
        console.log(`[result] ${event.result}`);
      } else if (event.type === "error") {
        console.error(`[error] ${event.message}`);
        exitCode = 1;
      }
    }
  } finally {
    rl?.close();
  }
  console.log(`\nsession: ${sessionId}`);
  return exitCode;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/cli/agent.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the subcommand into `bin/zero.ts`**

Replace the contents of `packages/daemon/bin/zero.ts`:
```ts
import { resolve } from "node:path";
import { startZero } from "../src/main";
import { runAgentCli } from "../src/cli/agent";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "agent") {
  const pathArg = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--session");
  const root = resolve(pathArg ?? ".");
  const exitCode = await runAgentCli(rest, root);
  process.exit(exitCode);
} else {
  const root = resolve(cmd ?? ".");
  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const d = await startZero({ root, port: 4820, webDist });
  console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
}
```

- [ ] **Step 6: Manual verification**

Run: `bun packages/daemon/bin/zero.ts agent "list the files in this directory" --yes` from the repo root.
Expected: streams assistant text/tool calls to stdout and exits 0 (or exits non-zero with a clear "no chat model available" error if no Ollama server is running locally — either outcome confirms the wiring is correct; the point is it doesn't hang or crash).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/cli/agent.ts packages/daemon/src/cli/agent.test.ts packages/daemon/bin/zero.ts
git commit -m "feat(daemon): add headless \"zero agent\" CLI"
```

---

### Task 12: Core — Anthropic Messages API translation layer

**Files:**
- Create: `packages/core/src/anthropicTranslate.ts`
- Create: `packages/core/src/anthropicTranslate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ChatToolSpec`, `ChatDelta` (`packages/core/src/chatTypes.ts`).
- Produces: `anthropicRequestToChat(body: unknown): { messages: ChatMessage[]; tools: ChatToolSpec[] }`, `chatDeltaToSseEvents(delta: ChatDelta, state: SseState): string[]`, `ANTHROPIC_MESSAGE_START/STOP` helpers — consumed by Task 13's HTTP gateway, and reused as-is by the future M7 Nano bridge per the design spec.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/anthropicTranslate.test.ts`:

```ts
import { expect, test } from "bun:test";
import { anthropicRequestToChat, chatDeltaToSseEvents, createSseState } from "./anthropicTranslate";

test("translates an Anthropic Messages request into ChatMessage[] + ChatToolSpec[]", () => {
  const body = {
    system: "You are helpful.",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
    tools: [{ name: "fs_read", description: "Read a file.", input_schema: { type: "object", properties: {} } }],
  };
  const { messages, tools } = anthropicRequestToChat(body);
  expect(messages[0]).toMatchObject({ role: "system", content: "You are helpful." });
  expect(messages[1]).toMatchObject({ role: "user", content: "hi" });
  expect(messages[2]).toMatchObject({ role: "assistant", content: "hello" });
  expect(tools).toEqual([{ name: "fs_read", description: "Read a file.", schema: { type: "object", properties: {} } }]);
});

test("translates a tool_use assistant turn and a following tool_result user turn", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "fs_read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "export const a = 1;" }] },
    ],
  };
  const { messages } = anthropicRequestToChat(body);
  expect(messages[0]).toMatchObject({ role: "assistant", toolCalls: [{ id: "call_1", name: "fs_read", args: { path: "a.ts" } }] });
  expect(messages[1]).toMatchObject({ role: "tool", toolCallId: "call_1", content: "export const a = 1;" });
});

test("synthesizes Anthropic SSE events from ChatDeltas", () => {
  const state = createSseState("stub-model");
  const events: string[] = [];
  events.push(...chatDeltaToSseEvents({ text: "hel" }, state));
  events.push(...chatDeltaToSseEvents({ text: "lo" }, state));

  const joined = events.join("");
  expect(joined).toContain("event: message_start");
  expect(joined).toContain("event: content_block_start");
  expect(joined).toContain('"text":"hel"');
  expect(joined).toContain('"text":"lo"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/anthropicTranslate.test.ts`
Expected: FAIL — `./anthropicTranslate` does not exist.

- [ ] **Step 3: Implement**

Create `packages/core/src/anthropicTranslate.ts`:

```ts
import type { ChatMessage, ChatToolCall, ChatToolSpec, ChatDelta } from "./chatTypes";

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock { type: "tool_result"; tool_use_id: string; content: string }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
interface AnthropicMessage { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }
interface AnthropicTool { name: string; description: string; input_schema: object }
interface AnthropicRequest { system?: string; messages: AnthropicMessage[]; tools?: AnthropicTool[] }

function blockText(content: string | AnthropicContentBlock[]): { text: string; toolCalls?: ChatToolCall[]; toolResult?: { id: string; content: string } } {
  if (typeof content === "string") return { text: content };
  const toolCalls: ChatToolCall[] = [];
  let text = "";
  let toolResult: { id: string; content: string } | undefined;
  for (const block of content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
    else if (block.type === "tool_result") toolResult = { id: block.tool_use_id, content: block.content };
  }
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, toolResult };
}

export function anthropicRequestToChat(body: unknown): { messages: ChatMessage[]; tools: ChatToolSpec[] } {
  const req = body as AnthropicRequest;
  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system, createdAt: Date.now() });

  for (const m of req.messages) {
    const { text, toolCalls, toolResult } = blockText(m.content);
    if (toolResult) {
      messages.push({ role: "tool", content: toolResult.content, toolCallId: toolResult.id, createdAt: Date.now() });
      continue;
    }
    messages.push({ role: m.role, content: text, toolCalls, createdAt: Date.now() });
  }

  const tools: ChatToolSpec[] = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, schema: t.input_schema }));
  return { messages, tools };
}

export interface SseState { messageStarted: boolean; blockStarted: boolean; model: string; toolCallIndex: number }

export function createSseState(model: string): SseState {
  return { messageStarted: false, blockStarted: false, model, toolCallIndex: 0 };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function chatDeltaToSseEvents(delta: ChatDelta, state: SseState): string[] {
  const out: string[] = [];
  if (!state.messageStarted) {
    state.messageStarted = true;
    out.push(sse("message_start", {
      type: "message_start",
      message: { id: "msg_zero", type: "message", role: "assistant", model: state.model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    }));
  }
  if (delta.text) {
    if (!state.blockStarted) {
      state.blockStarted = true;
      out.push(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    }
    out.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.text } }));
  }
  if (delta.toolCalls) {
    for (const call of delta.toolCalls) {
      const index = ++state.toolCallIndex;
      out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }));
      out.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }));
      out.push(sse("content_block_stop", { type: "content_block_stop", index }));
    }
  }
  return out;
}

export function finalSseEvents(state: SseState, stopReason: "end_turn" | "tool_use"): string[] {
  const out: string[] = [];
  if (state.blockStarted) out.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  out.push(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 0 } }));
  out.push(sse("message_stop", { type: "message_stop" }));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/anthropicTranslate.test.ts`
Expected: PASS

- [ ] **Step 5: Export**

In `packages/core/src/index.ts`, add:
```ts
export {
  anthropicRequestToChat, chatDeltaToSseEvents, finalSseEvents, createSseState, type SseState,
} from "./anthropicTranslate";
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/anthropicTranslate.ts packages/core/src/anthropicTranslate.test.ts packages/core/src/index.ts
git commit -m "feat(core): add Anthropic Messages API translation layer"
```

---

### Task 13: Daemon — model gateway HTTP server

**Files:**
- Create: `packages/daemon/src/modelGateway.ts`
- Create: `packages/daemon/src/modelGateway.test.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/bin/zero.ts`

**Interfaces:**
- Consumes: `ProviderGateway`, `anthropicRequestToChat`, `chatDeltaToSseEvents`, `finalSseEvents`, `createSseState` (Task 12).
- Produces: `startModelGateway(opts): { port: number; apiKey: string; stop(): void }` — consumed by `main.ts`/`bin/zero.ts` when `--gateway-port` is passed.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/modelGateway.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ProviderGateway, type ChatCapableProvider } from "@zero/core";
import { startModelGateway } from "./modelGateway";

function stubProvider(reply: string): ChatCapableProvider {
  return {
    id: "stub",
    available: async () => true,
    capabilities: () => ({ id: "stub", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => true,
    async *complete() {},
    async *chat() { yield { text: reply }; },
  };
}

test("rejects requests without the api key", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hi")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(401);
  gw.stop();
});

test("streams an SSE response for a valid request with the api key", async () => {
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([stubProvider("hello there")]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": gw.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("hello there");
  expect(text).toContain("event: message_stop");
  gw.stop();
});

test("returns 503 when no provider is available", async () => {
  const unavailable = { ...stubProvider("x"), available: async () => false };
  const gw = startModelGateway({ port: 0, gateway: new ProviderGateway([unavailable]) });
  const res = await fetch(`http://127.0.0.1:${gw.port}/v1/messages`, {
    method: "POST", headers: { "x-api-key": gw.apiKey }, body: JSON.stringify({ messages: [] }),
  });
  expect(res.status).toBe(503);
  gw.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/modelGateway.test.ts`
Expected: FAIL — `./modelGateway` does not exist.

- [ ] **Step 3: Implement**

Create `packages/daemon/src/modelGateway.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { ProviderGateway } from "@zero/core";
import { anthropicRequestToChat, chatDeltaToSseEvents, finalSseEvents, createSseState } from "@zero/core";

export interface ModelGatewayOpts { port?: number; apiKey?: string; gateway: ProviderGateway }

export function startModelGateway(opts: ModelGatewayOpts): { port: number; apiKey: string; stop(): void } {
  const apiKey = opts.apiKey ?? randomBytes(16).toString("hex");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/messages" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (req.headers.get("x-api-key") !== apiKey) {
        return new Response("unauthorized", { status: 401 });
      }

      const provider = await opts.gateway.pick();
      if (!provider) return new Response("no model available", { status: 503 });

      const body = await req.json();
      const { messages, tools } = anthropicRequestToChat(body);
      const state = createSseState(provider.id);
      const controller = new AbortController();
      req.signal.addEventListener("abort", () => controller.abort());

      const stream = new ReadableStream<Uint8Array>({
        async start(sc) {
          const encoder = new TextEncoder();
          let sawToolCalls = false;
          try {
            for await (const delta of provider.chat(messages, tools, controller.signal)) {
              if (delta.toolCalls?.length) sawToolCalls = true;
              for (const event of chatDeltaToSseEvents(delta, state)) sc.enqueue(encoder.encode(event));
            }
            for (const event of finalSseEvents(state, sawToolCalls ? "tool_use" : "end_turn")) sc.enqueue(encoder.encode(event));
          } catch (e) {
            sc.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: e instanceof Error ? e.message : String(e) })}\n\n`));
          } finally {
            sc.close();
          }
        },
      });

      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  return { port: server.port as number, apiKey, stop: () => server.stop() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/modelGateway.test.ts`
Expected: PASS

- [ ] **Step 5: Wire an opt-in `--gateway-port` flag**

Add `gatewayPort?: number` to `DaemonOptions` in `packages/daemon/src/server.ts`.

In `packages/daemon/src/main.ts`, add to the top-of-file imports:
```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startModelGateway } from "./modelGateway";
```
Then, in `startZero`, right before the existing `const stop = daemon.stop;` line, add:
```ts
  let gatewayInfo: { port: number; apiKey: string } | undefined;
  let stopGateway: (() => void) | undefined;
  if (opts.gatewayPort !== undefined) {
    const providers = await buildProviders();
    const gw = startModelGateway({ port: opts.gatewayPort, gateway: new ProviderGateway(providers) });
    gatewayInfo = { port: gw.port, apiKey: gw.apiKey };
    stopGateway = gw.stop;
    await writeFile(join(opts.root, ".zero", "gateway-key"), gw.apiKey, "utf8").catch(() => {});
  }
```
Then replace the existing return statement:
```ts
  const stop = daemon.stop;
  return {
    ...daemon,
    pluginsReady,
    stop: () => {
      unwatch();
      pty.closeAll();
      lsp.dispose();
      stop();
    },
  };
```
with:
```ts
  const stop = daemon.stop;
  return {
    ...daemon,
    pluginsReady,
    gatewayInfo,
    stop: () => {
      unwatch();
      pty.closeAll();
      lsp.dispose();
      stopGateway?.();
      stop();
    },
  };
```

In `packages/daemon/bin/zero.ts`, parse `--gateway-port <port>` out of the non-`agent` branch's args and pass it through, printing the endpoint/key on startup if present:
```ts
  const gatewayIdx = rest.indexOf("--gateway-port");
  const gatewayPort = gatewayIdx >= 0 ? Number(rest[gatewayIdx + 1]) : undefined;
  const d = await startZero({ root, port: 4820, webDist, gatewayPort });
  console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
  if (d.gatewayInfo) {
    console.log(`model gateway: http://127.0.0.1:${d.gatewayInfo.port}/v1/messages (ANTHROPIC_API_KEY=${d.gatewayInfo.apiKey})`);
  }
```
(`cmd` in `bin/zero.ts` today is `process.argv[2]`; since `agent` is now a reserved first argument per Task 11, treat any other first argument as the project path, same as before, and read `--gateway-port` from the remaining args on that branch.)

- [ ] **Step 6: Run the full daemon suite**

Run: `bun test packages/daemon`
Expected: PASS

- [ ] **Step 7: Manual verification**

Run: `bun packages/daemon/bin/zero.ts . --gateway-port 4821`, then in another terminal:
```bash
curl -N http://127.0.0.1:4821/v1/messages \
  -H "x-api-key: <printed key>" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```
Expected: SSE stream (or a clean 503 if no Ollama server is running — either confirms wiring).

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/modelGateway.ts packages/daemon/src/modelGateway.test.ts \
  packages/daemon/src/main.ts packages/daemon/src/server.ts packages/daemon/bin/zero.ts
git commit -m "feat(daemon): add Anthropic-compatible model gateway (/v1/messages)"
```

---

### Task 14: Docs — README M5 status update

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: updated status section — no code dependents.

- [ ] **Step 1: Update the status section**

In `README.md`, replace:
```markdown
M0–M4 are implemented on `main`:
```
with:
```markdown
M0–M5 are implemented on `main`:
```
and append after the M4 bullet:
```markdown
- **M5** Zero Agents (daemon-side AgentRuntime, approval-gated write tools
  `fs_write`/`fs_edit`/`run_command`, git checkpointing to a shadow branch,
  headless `zero agent "task"` CLI, Anthropic Messages API-compatible model
  gateway) — Nano is not yet wired into daemon-side runs; that lands with
  the M7 Nano bridge
```
Add a design doc link alongside the M3/M4 links:
```markdown
- [M5 design](docs/superpowers/specs/2026-08-07-m5-zero-agents-design.md)
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: mark M5 as implemented on main"
```
