# M4 Chat / AgentRuntime — Design

Date: 2026-08-06
Status: Approved

Per the roadmap (`docs/superpowers/specs/2026-08-04-zero-design.md` section 13),
M4 is: turn loop, layered system prompt, session persistence, token ledger,
pruning and compaction, read-only tools with tool calling on capable
backends, chat panel. It completes v1 scope.

## 1. Scope

### In scope

- **Chat-capable model providers:** `ChromeNanoProvider` and
  `OpenAICompatProvider` both gain a `chat()` method. Only providers that
  report `supportsTools() === true` (in practice, Ollama today) participate
  in the tool-calling loop; Nano still holds a plain conversation.
- **Read-only tools:** `fs/read`, `fs/tree`, `fs/search`, `graph/query`,
  `lsp/hover`, `lsp/definition`, wrapped as `ToolProvider`s over the existing
  daemon RPCs. No new daemon capability, no write tools, no approval gate
  (approval gates are an M5/write-tool concern).
- **`AgentRuntime`** in `@zero/core`: the turn loop — assemble prompt, call
  the active provider, loop on tool calls, persist the turn.
- **Layered system prompt:** fixed base layer + generated workspace/tool
  layer, rebuilt per turn.
- **Token ledger and compaction:** `estimateTokens`-based usage tracking;
  per-tool-output capping; summarization-based compaction at a 90% context
  budget threshold, collapsing all but the last 4 exchanges into a
  structured summary message.
- **Session persistence:** daemon-side `SessionStore`, one JSON file per
  session under `.zero/sessions/`, multiple named sessions per workspace.
- **Protocol:** `chat/*` RPC message types (create, list, get, append,
  rename, delete).
- **Chat panel UI:** new dockable workbench panel with session picker,
  message list, streaming input, mirroring `TerminalPanel`'s structure.

### Out of scope (explicit)

- Daemon-side `AgentRuntime` (headless `zero agent "task"` CLI) — M5.
- Write tools, command execution, git checkpointing, approval gates — M5.
- Model gateway / cloud providers / Anthropic-compatible bridge — M5, M7.
- Tool calling on `ChromeNanoProvider` (constrained-decoding emulation) —
  scoped to the model gateway in M5 per section 9 of the main design doc.
- Summarizing/compacting anything other than chat history (e.g. terminal or
  editor state) — not part of this milestone's context.

## 2. Architecture

M4 mirrors the M1 completion pipeline rather than introducing a new
daemon-side subsystem: the roadmap reserves "AgentRuntime daemon-side" for
M5, so in M4 the turn loop runs client-side in `@zero/web`, same place
`CompletionEngine` runs today.

- **`@zero/core`** (isomorphic, injected dependencies only): `AgentRuntime`
  (turn loop), `ChatCapableProvider` extension of `ModelProvider`,
  `ToolProvider` interface, `buildSystemPrompt`, token ledger and compaction
  logic. Talks to the daemon only through the existing
  `{ request<R>(method, params?): Promise<R> }` client shape that
  `GraphContext`/`LspContext` already use.
- **`@zero/daemon`**: `SessionStore` persists messages to
  `.zero/sessions/<id>.json` (`.zero/` is already gitignored, per the
  Graphify precedent). The daemon answers `chat/*` CRUD RPCs plus the
  existing `fs/*`, `graph/query`, `lsp/hover`, `lsp/definition` RPCs the
  tools wrap. It does not run the loop or call the model.
- **`@zero/web`**: `chatSetup.ts` (mirrors `completionSetup.ts`) builds
  `AgentRuntime` with `[ChromeNanoProvider, OpenAICompatProvider]`, a
  `DaemonToolProvider` set wrapping the four read tools, and a
  `SessionClient` wrapping `chat/*`. `ChatPanel` (mirrors `TerminalPanel`)
  renders it.

**Turn flow:** user sends a message → `AgentRuntime` loads/creates the
session via the daemon → assembles the layered system prompt plus (possibly
compacted) history → calls the active provider's `chat()` → on tool calls,
executes them via `ToolProvider` (daemon RPC), appends results, loops →
streams the final assistant text to the panel → persists the turn via
`chat/append`.

## 3. Protocol

New interfaces in `packages/protocol/src/messages.ts` (plain interfaces, no
Zod, matching existing convention — daemon-side Zod validates at the
boundary):

```ts
export interface ChatToolCall { id: string; name: string; args: unknown }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];   // present on assistant messages that call tools
  toolCallId?: string;          // present on tool-result messages
  toolName?: string;
  createdAt: number;
}
export interface ChatSessionSummary { id: string; title: string; updatedAt: number; messageCount: number }

export interface ChatCreateParams { title?: string }
export interface ChatCreateResult { id: string }
export interface ChatListResult { sessions: ChatSessionSummary[] }
export interface ChatGetParams { id: string }
export interface ChatGetResult { id: string; title: string; messages: ChatMessage[]; tokenLedger: { used: number; budget: number } }
export interface ChatAppendParams { id: string; messages: ChatMessage[] }
export interface ChatDeleteParams { id: string }
export interface ChatRenameParams { id: string; title: string }
```

The daemon stays a dumb store: `chat/append` appends and persists whatever
`AgentRuntime` decides to append (including compaction summary messages).
Compaction logic itself lives in `@zero/core`, where it is unit-testable
with fakes, not in the daemon.

## 4. Core: turn loop, prompt, tools, token ledger, compaction

**Chat-capable providers** — `ModelProvider` gains an optional chat
capability so existing FIM-only providers are unaffected:

```ts
export interface ChatToolSpec { name: string; description: string; schema: object }
export interface ChatDelta { text?: string; toolCalls?: ChatToolCall[] }
export interface ChatCapableProvider extends ModelProvider {
  chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta>;
  supportsTools(): boolean;
}
```

`OpenAICompatProvider` implements this fully (OpenAI-style `tools` param).
`ChromeNanoProvider` implements `chat()` for plain conversation and returns
`supportsTools() === false`; `AgentRuntime` skips the tool-calling branch
when the active provider reports no tool support.

**Tools** (`packages/core/src/tools.ts`) — a `ToolProvider` interface
(`name`, `description`, `schema`, `execute(args) => Promise<string>`),
backed in `@zero/web` by thin wrappers over
`client.request("fs/read"|"fs/tree"|"fs/search"|"graph/query"|"lsp/hover"|"lsp/definition", ...)`.
Each tool result is capped at a fixed character budget (~4000 chars) before
being appended as a `tool` message, so one large file read or search result
can't blow the turn's token budget on its own.

**Layered system prompt** (`packages/core/src/systemPrompt.ts`) —
`buildSystemPrompt({ tools, workspace })` concatenates a fixed base layer
(identity, tone, editing/tool-use rules) with a generated layer listing
available tool names/descriptions and workspace facts (root, active file,
language). Rebuilt fresh every turn so it reflects the current tool set and
workspace state; emitted as a single `system` message.

**Token ledger and compaction** (`packages/core/src/tokenLedger.ts`, reusing
`estimateTokens`) — tracks running usage against
`provider.capabilities().contextWindowTokens`. Before assembling a turn, if
projected tokens (system + history + new message) exceed 90% of budget,
`AgentRuntime` runs a compaction pass: one extra non-tool `chat()` call
asking the model to summarize prior turns into fixed sections (Goal,
Decisions, Files touched, Next steps), replaces all but the last 4 exchanges
with that summary as a single `system` message, and persists the compacted
history back via `chat/append`.

**`AgentRuntime`** (`packages/core/src/agentRuntime.ts`) — orchestrates one
turn: load session, maybe-compact, build prompt, call `chat()`, loop on tool
calls (execute via `ToolProvider`, append results, re-call) until a final
text response, then persist. No tool-approval gate in M4 — all four tool
families are read-only.

## 5. Daemon: session store

`packages/daemon/src/sessions.ts` — a `SessionStore` class (constructed with
`Workspace`, matching the pattern of other daemon subsystems) reading/writing
`.zero/sessions/<id>.json`: an array of `ChatMessage` plus
`{ id, title, updatedAt }`.

`chat/create|list|get|append|rename|delete` are registered alongside the
existing `graph/*`/`plugin/*` RPCs in `main.ts`/`rpc.ts`. Purely file-backed
CRUD — no model calls, no tool execution.

## 6. Web: chat panel

- `packages/web/src/chatSetup.ts` (mirrors `completionSetup.ts`): builds
  `AgentRuntime` with `[ChromeNanoProvider, OpenAICompatProvider]`, the four
  daemon-backed tools, and a `SessionClient` wrapping the `chat/*` RPCs.
- `packages/web/src/workbench/chat/ChatPanel.tsx` + `store.ts` +
  `SessionPicker.tsx` (mirrors `terminal/TerminalPanel.tsx` + `store.ts`):
  message list (user/assistant/tool bubbles, streaming text), input box,
  session dropdown (list/create/rename/delete), and a status pill reusing
  the `StatusPill` pattern for the active chat model.
- `Workbench.tsx` gets a new dockable panel slot and a command-palette
  entry / keybinding to toggle it, following the existing pane-registration
  pattern.

## 7. Testing

- `@zero/core`: dense unit coverage with scripted fake
  `ChatCapableProvider`/`ToolProvider` — turn loop happy path, multi-round
  tool-call loop, compaction trigger at the 90% threshold, tool-output
  capping, layered prompt assembly, cancellation via `AbortSignal`.
- `@zero/daemon`: `SessionStore` integration tests against real temp dirs
  (create/append/list/delete, restart-survives-persistence).
- `@zero/protocol`: schema/shape round-trip tests for the new `chat/*`
  message interfaces.
- E2E: a "chat turn with tool approval" Playwright flow is listed in the
  main design doc's testing section for a future pass; approval isn't in
  scope for M4, so this stays deferred.

## 8. Roadmap fit

M3 already exposed `graph/query` explicitly so M4 could wrap it as a tool
without a protocol redesign; this design does exactly that, plus the
existing `fs/*` and `lsp/*` RPCs from M0–M2. Completing M4 finishes v1 scope
per the roadmap; M5 (Zero Agents) reuses `AgentRuntime`, tool-calling, and
the token ledger, moving the runtime daemon-side and adding write tools with
approval gates.
