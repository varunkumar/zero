# Zero: Local-First Coding Environment. Design and Roadmap

Date: 2026-08-04
Status: Approved design, pre-implementation

## 1. Vision

Zero is a local-first coding environment. The primary use case is coding fully
offline: the user writes code by hand with copilot-style inline completions
from an on-device model, with an integrated terminal and a chat panel for
asking about the codebase. Online capabilities come later and are strictly
additive.

Zero is a platform with multiple flavours sharing one core:

- Zero (v1): browser UI plus local daemon; editor, completions, terminal, LSP,
  Graphify context, chat.
- Zero Agents: headless autonomous agent runs over the same engine.
- Zero Lite: pure-browser, zero-install flavour. No daemon, browser APIs only.
- Zero Claude Plugin: exposes Gemini Nano on Chrome as a model that Claude
  Code can be pointed at, enabling a fully offline Claude Code.
- Zero IDE: desktop app wrapping the same client and daemon.

## 2. Core decisions

| Decision | Choice |
|---|---|
| v1 platform | Browser web app + local daemon |
| Daemon stack | TypeScript on Node/Bun |
| Primary completion model | Gemini Nano via Chrome's built-in Language Model (Prompt) API |
| Model backends | Pluggable; OpenAI-compatible provider covers Ollama (default fallback), LM Studio, llama.cpp server, cloud later |
| Architecture shape | Isomorphic core package: the engine runs in the browser for v1 and in the daemon for Zero Agents |
| Context sources | Modeled as plugins (context providers); Graphify is the first built-in plugin |
| v1 scope | Editor + inline completion + terminal + chat panel |

## 3. Architecture overview

Monorepo:

```
zero/
  packages/
    core/        # @zero/core - isomorphic engine (no DOM, no Node APIs)
    protocol/    # @zero/protocol - shared JSON-RPC message and event types
    daemon/      # @zero/daemon - Node/Bun capability server
    web/         # @zero/web - browser client
  docs/
```

Runtime picture: `zero [path]` starts the daemon in a project directory. The
daemon indexes the project and serves the web client at
`http://localhost:<port>`. The browser connects back over one WebSocket
carrying JSON-RPC both ways. Everything works with the network unplugged.

Where things run:

- Browser: CodeMirror 6 editor, completion engine and AgentRuntime (from
  @zero/core), chat panel, xterm.js terminal UI, settings, ChromeNanoProvider.
- Daemon: file system, project watching, PTY sessions, LSP server management,
  Graphify indexer, plugin host, session store, static serving of the client.

Flavour leverage: Zero IDE wraps the same client and a bundled daemon in
Tauri. Zero Agents instantiates the same engine daemon-side. Zero Lite swaps
the daemon-backed workspace for a browser-native one. Zero Claude Plugin
reuses the daemon-to-browser bridge to serve Nano over an Anthropic-compatible
endpoint.

## 4. @zero/core: engine and interfaces

Pure TypeScript, no DOM or Node APIs; all capabilities are injected. Five
interfaces define the system:

### 4.1 ModelProvider

`complete(prompt, opts)` and `chat(messages, opts)`, both streaming, plus
`capabilities()` reporting context window, FIM support, native tool calling,
constrained decoding support, and speed class. v1 implementations:

- ChromeNanoProvider (browser only): wraps Chrome's Language Model API,
  including the capability probe, model download flow, and responseConstraint
  based constrained decoding.
- OpenAICompatProvider: any OpenAI-compatible endpoint. Default target is
  Ollama; also covers LM Studio, llama.cpp server, and cloud APIs later.

### 4.2 ContextProvider

`gather(request): ContextChunk[]` where the request carries cursor position,
file, and intent (completion vs chat). Chunks carry a relevance score and
token cost. v1 implementations: BufferContext (open files, recent edits),
LspContext (definitions, signatures, diagnostics near cursor), GraphContext
(Graphify neighborhood of the current symbol).

### 4.3 WorkspaceProvider

open/read/write/watch/list/search over the workspace. Implementations:
DaemonWorkspace (RPC, v1 default) and BrowserFSWorkspace (File System Access
API, powers Zero Lite). The editor and engines never bind directly to the
daemon; capability flags hide missing features per backend.

### 4.4 ToolProvider

Declares tools (name, description, JSON schema) and executes them. Tools live
daemon-side (read and search files, LSP lookups, graph queries, run terminal
command) and are invoked over RPC. Anything mutating or shell-running
requires user approval via a followup_request pause.

### 4.5 CompletionEngine

Debounces keystrokes, gathers context within a latency budget (does not wait
more than ~50ms for slow providers; late chunks miss the prompt), assembles a
FIM-style prompt sized to the model's window, streams the completion, caches
and cancels aggressively. Only one request in flight; cancelled on keystroke.

### 4.6 AgentRuntime

One component powers the chat panel and Zero Agents. The turn loop: build
input, invoke model with tool definitions, stream events, execute tool calls
and loop, complete turn.

- Event stream (typed union in @zero/protocol): text_delta, reasoning_delta,
  tool_call_start, tool_call_result, followup_request, notice, turn_complete.
  The chat panel is a renderer of this stream; Zero Agents runs it headless.
- System prompt builder, layered: base identity, behavior overlay, workspace
  instructions (AGENTS.md / CLAUDE.md if present), explicit workspace root,
  environment facts. Each layer is a function of the session so flavours
  override layers, not the whole prompt.
- Sessions and turns: a Session is a list of Turns (user message, model
  calls, tool calls, final text, token counts). The daemon persists full
  history under `.zero/sessions/` (gitignored). The model sees only the
  working set.
- Token ledger: per-call, per-turn, per-session tracking; provider-reported
  usage when available, chars/4 estimate for pre-call budgeting.
- Pruning (within a turn): tool outputs truncated when the working set passes
  ~70% of the window.
- Compaction (between turns): at ~90%, older turns are summarized into a
  structured summary with fixed headings (Goal, Constraints, Done, In
  Progress, Blocked, Key Decisions, Critical Context, Relevant Files, Next
  Steps), keeping the last N exchanges verbatim. Full history stays on disk.
- Small-model scaling: the runtime adapts to capabilities(). With Nano (~6K
  window, no native tool calling): tight budgets, N ~2, frequent compaction,
  tools disabled by default or driven through constrained-JSON decoding
  behind a flag. With Ollama-class or cloud models: native tool calling and
  32K+ windows, same loop. v1 chat is "ask about my code with context"; the
  autonomous multi-step agent is the Zero Agents milestone on the same
  runtime.

### 4.7 Plugins

Daemon-side packages (built-ins plus `~/.zero/plugins`), each declaring
contributions in a manifest: context providers (served to the browser over
RPC), model providers, tools, commands, later panels. Plugins run in-process
in v1; worker isolation is roadmap hardening. Browser-side providers such as
ChromeNanoProvider are registered in client code, not the manifest.

## 5. @zero/daemon

Single Node/Bun process. Binds 127.0.0.1 only; generates a session token and
rejects WebSocket connections without it (any website can probe localhost
ports, so localhost-only is not sufficient).

- Workspace service: read/write/watch under the workspace root with path
  traversal guarded; file-change events keep editor, indexer, and LSP in
  sync; gitignore-aware tree and fuzzy search (native fs and ripgrep).
- PTY service: shells via node-pty, streaming both ways, resize and kill.
  Terminal state lives in the daemon so a browser refresh reattaches to
  running shells. Later gives Zero Agents supervised command execution.
- LSP service: spawns language servers from a data-driven registry (v1:
  typescript-language-server, pyright). Speaks LSP to servers, re-exposes a
  simplified subset over Zero RPC: diagnostics, hover, definitions,
  references, document symbols, and contextAt(file, position) purpose-built
  for LspContext. The browser never speaks raw LSP.
- Plugin host: loads plugins per section 4.7.
- Graphify plugin (first built-in): tree-sitter incremental indexer producing
  a graph in the graphify-out schema (files, symbols, imports,
  call/reference edges). Full index on first open in the background;
  incremental on change. Contributes GraphContext, graph/query RPC, and
  graph tools for chat.
- Model gateway (built in M5/M7): local HTTP endpoints backed by model
  providers, including reverse-RPC to a browser-hosted Nano. See section 9.
- Session store: chat sessions, turns, compaction summaries under `.zero/`.
- Static server: serves the built web client.

## 6. @zero/web

TypeScript + React, CodeMirror 6, xterm.js. Layout: file tree | editor tabs |
chat panel (right) | terminals (bottom), all collapsible.

- Editor: CodeMirror 6 with Lezer syntax highlighting; LSP-backed
  diagnostics, hover, go-to-definition via the daemon's simplified calls.
  Dirty-buffer sync: daemon owns disk truth, browser owns unsaved buffer
  state and pushes deltas so context providers see what the user sees.
- Completion UX: inline ghost text; Tab accepts, Esc dismisses, word-level
  partial accept. Debounce ~150ms after typing pauses. Status pill shows the
  live model. Degradation: Nano unavailable -> configured Ollama endpoint ->
  completions off with a visible reason; the editor always works.
- Chat panel: renders the AgentRuntime event stream; streamed markdown,
  collapsible tool-call cards, inline approval UI for followup_request, token
  and compaction indicator, insert-at-cursor and copy on code blocks. No
  auto-apply of edits in v1.
- Nano integration: startup capability probe feature-detects the Language
  Model API, drives model download with progress UI, reports the real context
  window into capabilities(). Chrome-specific code confined to
  ChromeNanoProvider and the probe.
- Settings: model backend picker (Nano / Ollama endpoint and model / off per
  feature), context provider toggles; keybindings later.

Completion data flow: keystroke -> debounce -> ContextRequest -> parallel
BufferContext locally + RPC for LspContext/GraphContext under a 50ms budget
-> FIM prompt sized to the model window -> Nano streams -> ghost text ->
accept inserts and pushes a buffer delta to the daemon.

## 7. Protocol (@zero/protocol)

One WebSocket, JSON-RPC 2.0 framing. All message and event types are shared
TypeScript types with Zod schemas validated at the boundary. Three traffic
classes:

1. Request/response: fs ops, LSP calls, graph queries.
2. Server-push events: file changes, diagnostics, PTY output.
3. Streams: completion, chat, and tool events with a stream id; cancellation
   is first-class.

Binary PTY data rides the same socket base64-encoded in v1; revisit only if
measured as a problem.

## 8. Error handling and degradation

Rule: the editor never breaks because intelligence is unavailable.

- Per-subsystem health (Nano, Ollama, each LSP server, indexer) in a status
  bar; failures degrade only that subsystem, with reason and retry.
- Daemon connection lost: editor goes read-only with a reconnect banner;
  unsaved buffers held in memory and IndexedDB. PTY sessions survive
  reconnects daemon-side; daemon death kills PTYs and the UI says so.
- Model calls: timeout plus one silent retry; late completions are dropped,
  never shown.
- Context providers are budget-sandboxed: a slow or crashing provider is
  skipped for that request and health-flagged; a broken plugin cannot stall
  typing.
- External concurrent edits to a dirty file: last-writer-wins with a conflict
  banner offering diff or reload. No CRDTs until multi-client editing is a
  goal.

## 9. Zero Claude Plugin: Nano as a Claude Code model

Goal: set Gemini Nano on Chrome as the model Claude Code uses, for a fully
offline Claude Code.

Bridge: the daemon's model gateway exposes an Anthropic Messages
API-compatible endpoint (`POST /v1/messages`, SSE streaming). Requests are
fulfilled by reverse-RPC to a browser context running ChromeNanoProvider:
either the open Zero client or a daemon-launched app-mode/headless Chrome
"Nano host" page. Then `ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude`
runs Claude Code's normal loop against Nano. This is the one deliberate use
of reverse-RPC in the system, because the model genuinely only exists inside
the browser.

Translation layer (the real work; lives in @zero/core, shared with
AgentRuntime's constrained-JSON path):

- Messages wire format to Nano prompt: system prompt, multi-turn messages,
  tool definitions rendered into the prompt.
- Tool calling: the CLI executes tools; the model only emits the structured
  tool_use decision. Nano has no trained tool-calling head, so the bridge
  uses Prompt API responseConstraint (JSON schema constrained decoding) to
  force output into "text answer or tool invocation matching one of these
  schemas", then maps that to tool_use / tool_result blocks on the wire.
- SSE synthesis: message_start, content_block_delta, etc. from Nano's stream.
- Window management: Claude Code sends far more than Nano's ~6K window; the
  bridge reuses core pruning/budgeting to truncate sanely and reports honest
  usage numbers.

Stated expectation: this yields a functioning offline Claude Code, not
parity. Wrong-tool or bad-argument choices are a small-model capability
limit, not plumbing. The plugin packages the ergonomics: a launcher that
starts the bridge, verifies a Nano host, prints the env to switch, and shows
health. The same gateway serves Zero Agents for Nano-backed runs.

## 10. Zero Lite

Pure browser flavour, no daemon, browser APIs only: BrowserFSWorkspace over
the File System Access API (persistent permissions), Nano completions and
chat with buffer-level context, optional slow in-browser tree-sitter index
later. No terminal, no LSP. Hosted as a static site; zero install. Known
platform constraints: FileSystemObserver is still experimental (fall back to
polling), and search reads files through sandboxed handles (slower than the
daemon path). Capability flags in WorkspaceProvider hide missing features.

## 11. Testing

- @zero/core: dense unit coverage with injected fakes. Prompt assembly per
  window size, budget and latency accounting, compaction and pruning, the
  turn loop with scripted ModelProvider/ToolProvider fakes, cancellation.
- Daemon: integration tests against real temp dirs, a real PTY, and a real
  typescript-language-server in CI.
- Protocol: schema round-trip tests; daemon-against-fake-client tests for
  reconnect and reattach.
- Model quality: an offline eval harness of a few dozen FIM cases run against
  Nano and Ollama producing a report. Not CI-gated; run before releases.
- E2E: a few Playwright flows (open project, ghost text with stubbed model,
  terminal command, chat turn with tool approval).

## 12. Roadmap

- M0, Skeleton: monorepo, @zero/protocol, daemon serving the client,
  WebSocket RPC, file tree, CodeMirror editing, save. Usable as a bare local
  editor.
- M1, Completion: core engine, ChromeNanoProvider and probe, BufferContext,
  ghost-text UX, OpenAICompatProvider (Ollama) fallback, status pill. Usable
  as an offline copilot.
- M1.5, Editor shell: turn the minimal M0 web shell into a VS Code-class
  editor UI. Scope: workbench layout (resizable and collapsible panes, split
  editors), editor tabs with dirty indicators, command palette, fuzzy file
  opener (Cmd+P), global search panel, virtualized file tree with file
  icons, keybinding system, light and dark themes, status bar, settings UI.
  No new daemon capabilities; UI only. Gets its own design session and spec
  before implementation. Can run any time after M1, independent of M2+.
- M2, Terminal and LSP: PTY service and xterm.js with reattach; LSP service
  (TS, Python); diagnostics, hover, definitions; LspContext feeding
  completions.
- M3, Graphify and plugin host: plugin host, Graphify indexer as first
  built-in, GraphContext, graph query tools, eval harness proving context
  quality.
- M4, Chat / AgentRuntime: turn loop, layered system prompt, session
  persistence, token ledger, pruning and compaction, read-only tools with
  tool calling on capable backends, chat panel. Completes v1 scope.
- M5, Zero Agents: AgentRuntime daemon-side with Ollama/cloud models; write
  tools with approval gates, command execution via PTY service, headless
  `zero agent "task"` CLI, git checkpointing. Model gateway lands here.
- M6, Zero Lite: BrowserFSWorkspace, in-browser context, static hosting.
- M7, Zero Claude Plugin: Anthropic-compatible Nano bridge per section 9.
- M8, Zero IDE: Tauri wrap with bundled daemon (Bun compile), auto-update,
  native menus. Plugin worker isolation and online capabilities (cloud
  providers, sync) land in this era.

Ordering rationale: M1 before terminal/LSP because offline completion is the
product's reason to exist; M3 before chat because chat is only as good as its
context; agents before Lite/plugin/IDE because they reuse the most of M4.

## 13. References

- Agent loop, streaming events, layered prompts: "Build a Coding Agent from
  Scratch: The Simple Loop Behind Zero" (S. Rajagopal).
- Compaction, pruning, token ledger: "Building a Coding Agent from Scratch,
  Part 2: Solving the Context Window" (S. Rajagopal).
