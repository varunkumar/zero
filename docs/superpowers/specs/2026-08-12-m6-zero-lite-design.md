# M6: Zero Lite

Date: 2026-08-12
Status: Approved

Per the roadmap (`docs/superpowers/specs/2026-08-04-zero-design.md` section 13),
M6 is: BrowserFSWorkspace, in-browser context, static hosting. Section 11
defines the flavour: pure browser, no daemon, File System Access API,
Nano completions and chat with buffer-level context, no terminal, no LSP,
hosted as a static site.

M0-M5 (and the M5.1 CLI / workbench UX follow-ups) are on `main`. The
workbench talks to a daemon `RpcClient` for every file, chat, git, graph,
LSP, and PTY call. There is no `WorkspaceProvider` type in `@zero/core`
yet (section 4.3 of the original design named it; M6 does not extract it).

## 1. Scope

### In scope

- **Same `packages/web` client**, not a second Vite entry. Daemon mode is
  unchanged when `zero serve` is up.
- **Capability flags** from a new `session/hello` RPC. Lite reports no PTY,
  LSP, graph, or git. Workbench hides those panels, commands, and pills.
- **In-process RPC backend:** a `SocketLike` that dispatches the existing
  JSON-RPC methods locally. `App` still constructs an `RpcClient`.
- **`BrowserFSWorkspace`** in `packages/web` (DOM/FSA only; not in
  `@zero/core`). Implements the `fs/*` method set the UI already calls.
- **Landing screen** with Open folder; persist the directory handle in
  IndexedDB; re-prompt if permission is gone.
- **Completions:** `ChromeNanoProvider` + `BufferContext` only.
- **Chat:** `AgentRuntime` in the page, Nano only, tools `fs_read` /
  `fs_tree` / `fs_search` / `fs_write` / `fs_edit` with the existing
  approval gate. Sessions in IndexedDB.
- **Search and watch:** walk handles for `fs/search`; `FileSystemObserver`
  if present, else poll + diff, emit `fs/changed`.
- **gitignore:** parse `.gitignore` files; always skip `.git` and
  `node_modules` in tree/search.
- **Static hosting:** Vite build + Cloudflare Pages config + README. The
  Pages project is connected in the Cloudflare dashboard (no GitHub
  Actions deploy job in this milestone).
- **README / status:** M6 marked implemented; Lite usage documented.

### Out of scope (explicit)

- Extracting `WorkspaceProvider` into `@zero/core` (original section 4.3).
  Revisit if a third backend appears.
- A second Lite HTML entry or a slimmer Lite shell.
- Terminal, LSP, Graphify, git status/remote, `run_command`.
- Ollama / cloud / any network model call from the page.
- In-browser tree-sitter index.
- Firefox / Safari (no `showDirectoryPicker` in the required shape).
- Service worker / PWA / offline cache.
- Sharing daemon `~/.zero` sessions with Lite.
- GitHub Actions (or other CI) that deploys Pages. Dashboard connect only.
- Offering Open folder while a daemon connection is live.

## 2. Decisions (from design session)

| Topic | Choice |
|---|---|
| Client shape | Same workbench, capability flags |
| Wiring | In-process `RpcClient` backend (approach A) |
| Chat | In-browser `AgentRuntime`, read + write tools, approval gate |
| Models | Chrome Nano only |
| Hosting | Cloudflare Pages, dashboard-connected, no CI job |
| Daemon present | Always use the daemon; do not offer Lite |
| Settings | Existing `localStorage` cache only |
| Sessions | IndexedDB, keyed per directory handle |
| Watch | Observer if available, else poll |
| gitignore | Parse + hard-skip `.git` / `node_modules` |

## 3. Architecture

```
zero serve (localhost)                    static origin (Pages)
─────────────────────                     ─────────────────────
App.connect() → WebSocket /rpc            App.connect() → landing
RpcClient → daemon                        Open folder → FSA handle
Workbench (all capabilities)              persist handle (IndexedDB)
                                          in-process SocketLike
                                          RpcClient → local router
                                            ├─ BrowserFSWorkspace (fs/*)
                                            ├─ LiteChatHost (chat/*)
                                            └─ session/hello (flags)
                                          Workbench (pty/lsp/graph/git off)
                                          AgentRuntime + ChromeNanoProvider
                                          BufferContext only
```

**Layering**

1. `@zero/protocol` grows `session/hello` types and a `WorkspaceCapabilities`
   shape. No transport change.
2. `@zero/core` is unchanged in kind. Completions and `AgentRuntime` already
   accept injected providers and tools. Lite does not add DOM imports there.
3. `packages/web/src/lite/` owns FSA, the local router, IndexedDB session
   store, handle persistence, and the landing screen.
4. `App.tsx` chooses daemon socket vs landing vs local router.
5. `Workbench` (and command registration) reads capabilities once and omits
   unavailable subsystems. Editor, tree, search, chat, settings keep calling
   `client.request(...)`.

This is deliberately a facade over the existing RPC surface, not a workbench
rewrite. Local calls still look like JSON-RPC. That is acceptable for M6:
one client, existing fakes, one new backend module.

## 4. Boot and `session/hello`

### 4.1 Connect algorithm

`connect()` today always opens `ws://${location.host}/rpc?token=...` and
rejects with "daemon unreachable" on error. Change:

1. If the page is served by the daemon (same-origin WebSocket that opens
   and authenticates), use it. Do not show Open folder.
2. If the WebSocket fails, or the origin is known-static (no token, not a
   daemon host), do **not** treat that as a fatal `connectError`. Return
   control to `App` in an unconnected Lite-ready state.
3. `App` shows the landing screen until a directory handle is available
   (fresh pick or restored from IndexedDB with granted permission).
4. Then `connectLite(handle)` builds the in-process `SocketLike`, wraps it
   in `RpcClient`, and mounts `Workbench`.

Detection rule (deterministic, no heuristic timeouts beyond the browser's
WS failure):

- Presence of `?token=` (daemon URL) or a successful WS open: daemon mode.
- Otherwise: Lite landing. A failed WS on a tokenized URL still shows the
  existing "Failed to connect" error, not Lite. `zero serve` users should
  not silently fall into a different workspace.

### 4.2 Landing screen

Zero mark, title, one sentence ("Open a local folder in the browser. Chrome
or Edge with Gemini Nano required."), primary **Open folder** button.

- `showDirectoryPicker({ mode: "readwrite", id: "zero-lite" })`.
- Missing API: replace the button with an explanation that Chrome or Edge
  is required. Do not render a broken workbench.
- Picker cancelled: stay on landing.
- After pick: store `{ id, name, handle }` in IndexedDB (`zero-lite-roots`).
  Generate a UUID `id` on first pick. On later visits, iterate stored
  handles, `queryPermission({ mode: "readwrite" })`, and if `"granted"`
  reopen that folder automatically. If `"prompt"`, show landing with a
  **Reopen \<name\>** button that calls `requestPermission` (must be in a
  user gesture). If `"denied"` or the handle is gone, drop the record.

Switching folders in Lite is a landing-screen action (a **Change folder**
command that tears down the workbench and returns to landing). Not in the
daemon workbench.

### 4.3 Capabilities handshake

New RPC, both backends implement it. Workbench calls it once after connect
before creating panels.

```ts
interface WorkspaceCapabilities {
  pty: boolean;
  lsp: boolean;
  graph: boolean;
  git: boolean;
  models: Array<"nano" | "openai-compat">;
}

interface SessionHelloResult {
  capabilities: WorkspaceCapabilities;
  workspace: { name: string; kind: "daemon" | "browser-fs" };
}
```

Daemon: all four booleans `true`, `models: ["nano", "openai-compat"]`,
`kind: "daemon"`, `name` is the workspace directory basename.

Lite: `pty/lsp/graph/git` all `false`, `models: ["nano"]`,
`kind: "browser-fs"`, `name` is the picked folder's `handle.name`.

Workbench when a flag is false:

- `pty`: do not add the Terminal panel; do not register terminal commands
  or keybindings.
- `lsp`: do not subscribe to diagnostics, do not wire hover / definition.
- `graph`: no graph status pill, no graph wait in completion setup.
- `git`: no git status / GitHub remote pill.

Chat, Files, Search, Settings, palette, tabs, completions stay.

Unimplemented Lite methods (`pty/*`, `lsp/*`, `graph/*`, `git/*`) return
JSON-RPC error `{ code: -32601, message: "method not available in lite" }`.
The UI must not call them when the flag is false; the error is a backstop.

## 5. BrowserFSWorkspace

File: `packages/web/src/lite/browserFs.ts`.

The only module that touches File System Access types. It exposes async
methods matching the daemon `Workspace` surface the router needs:

```ts
read(path: string): Promise<string>
write(path: string, content: string): Promise<void>
tree(): Promise<TreeEntry[]>
search(query: string, caseSensitive?: boolean): Promise<FsSearchResult>
create(path: string, kind: "file" | "dir"): Promise<void>
rename(path: string, newPath: string): Promise<void>
delete(path: string): Promise<void>
move(path: string, newPath: string): Promise<void>
copy(path: string, newPath: string): Promise<void>
```

### 5.1 Paths

Workspace-relative POSIX strings (`src/app.ts`). Empty or `"."` is the
root. Reject if any segment is `..`, if the path is absolute, or if it
contains a Windows drive prefix. Resolve by walking `getDirectoryHandle` /
`getFileHandle` from the root handle. Never use a handle from outside the
picked tree.

### 5.2 Tree and ignore

`tree()` walks recursively and returns the same `{ path, kind }[]` as
`fs/tree`. Always omit `.git` and `node_modules` (any depth). Also omit
paths matched by `.gitignore` files: read `.gitignore` at the root and at
each directory that has one, using the `ignore` package (it is already a
daemon dependency; add it to `@zero/web` as well). A missing `.gitignore`
is fine. Ignore rules apply to both `tree` and `search`, not to an explicit
`read`/`write` of a path the user (or the model, after approval) named.

### 5.3 Search

Literal substring, same `FsSearchResult` as the daemon (`matches[]` with
path/line/column/text, plus `truncated`). Skip non-text and files larger
than 1 MiB. Cap wall time at 2s; if the cap hits, return what was found
with `truncated: true`. No ripgrep, no regex.

### 5.4 Mutations

`write` / `create` / `rename` / `delete` / `move` / `copy` use
`getFileHandle` / `getDirectoryHandle` with `{ create: true }` where
needed, `removeEntry({ recursive: true })` for delete of dirs. `rename` of
a file is write-new + remove-old if the API has no native rename on that
handle. Overwrite policy matches the daemon: `write` creates or replaces;
`create` fails if the path exists.

After any successful mutation the router emits `fs/changed` for the
affected path(s).

### 5.5 Watch

`packages/web/src/lite/watch.ts`. If `FileSystemObserver` is on
`globalThis`, observe the root and map events to `fs/changed`. Otherwise
poll `tree()` every 3s, diff path sets, emit `fs/changed` for added and
removed paths. The editor already reloads a non-dirty buffer on
`fs/changed`. Do not reload dirty buffers.

## 6. In-process router

File: `packages/web/src/lite/localRpc.ts`.

Implements `SocketLike` (`send`, `onmessage`). `send(raw)`:

1. `parseMessage(raw)`.
2. If it is a request, `await dispatch(method, params)`, then
   `onmessage(JSON.stringify({ jsonrpc: "2.0", id, result }))` or an
   `error` object.
3. Notifications from the "server" (fs/changed, chat/turnEvent) are posted
   the same way, with no `id`.

Dispatch table (Lite):

| Method | Handler |
|---|---|
| `session/hello` | capabilities in §4.3 |
| `fs/read` `fs/write` `fs/tree` `fs/search` | `BrowserFSWorkspace` |
| `fs/create` `fs/rename` `fs/delete` `fs/move` `fs/copy` | same |
| `chat/create` `chat/list` `chat/get` `chat/rename` `chat/delete` `chat/append` | IndexedDB session store |
| `chat/turn` `chat/abort` `chat/approve` `chat/status` | `LiteChatHost` |
| `settings/get` `settings/set` | no-op success using the existing client `localStorage` cache (return `{ value: null }` for get if the web settings store is the source of truth; do not invent a second settings file) |

Everything else: method-not-found.

The router is unit-tested by constructing a real `RpcClient` over it, the
same way protocol tests construct a client over a fake socket.

## 7. Completions and chat

### 7.1 Completions

`createCompletion` takes an options bag `{ lite?: boolean }`. When
`lite: true` it registers:

- providers: `[new ChromeNanoProvider(nanoApi)]` only
- context: `[buffers]` only (`BufferContext`)

Daemon path stays Nano + Ollama-compat + LspContext + GraphContext.

Nano unavailable: existing status pill; editor remains usable. No silent
Ollama attempt from Lite.

### 7.2 Lite chat host

`packages/web/src/lite/chatHost.ts`.

Mirrors the daemon pool at a smaller scale: one `AgentRuntime` per session
id, created on first `chat/turn`, evicted on `chat/delete`.

- Provider: `ChromeNanoProvider` only. If `available()` is false, the turn
  emits the same error-shaped `chat/turnEvent` the daemon emits when no
  model is up, and the pill explains Nano is missing.
- Tools: copy the `fs_read` / `fs_tree` / `fs_search` / `fs_write` /
  `fs_edit` definitions from `packages/daemon/src/chatTools.ts`, bound to
  `BrowserFSWorkspace` instead of `Workspace`. Move `diffPreview` into
  `@zero/core` if it is pure TypeScript (no Node/Bun APIs); otherwise
  duplicate those few lines in `packages/web/src/lite/`. Do **not** import
  `@zero/daemon` from web.
- Approval: existing `needsApproval` + `chat/approve` path. The panel
  already renders `approvalRequest` events.
- After an approved `fs_write` / `fs_edit`, emit `fs/changed`.
- System prompt: `buildSystemPrompt` with `workspace: { name, root:
  "browser-fs:<folderName>" }`. If `AGENTS.md` or `CLAUDE.md` exists at
  the workspace root, pass their contents through the existing workspace-
  instructions layer.

### 7.3 Sessions

`packages/web/src/lite/sessionStore.ts`. IndexedDB database `zero-lite`,
store `sessions`, key `id`. Each record matches the daemon session JSON
shape as closely as practical (`id`, `title`, `createdAt`, `updatedAt`,
`messages`, compaction summary if the runtime already persists one).

Partition by directory: every record stores `rootId` (the UUID from
§4.2). `chat/list` returns only sessions for the current root. A
different folder does not see the previous folder's chats.

No migration from `~/.zero`. No sync.

## 8. Hosting

`packages/web` already builds a static app. M6 adds:

- `packages/web/wrangler.toml` for Cloudflare Pages, output
  `packages/web/dist`, SPA fallback `/* → /index.html`. Pages project
  name: `zero-lite` (hostname `zero-lite.pages.dev` unless a custom
  domain is attached later).
- Build command documented for the dashboard:
  `bun install && bun run --cwd packages/web build`.
  Output directory: `packages/web/dist`.
- `vite.config.ts`: keep `base: "/"`. Pages project hostname is the
  origin; no repo-path suffix.
- README: "Zero Lite" section with Chrome/Edge + Nano requirements, the
  Open folder flow, the dashboard build settings, and the Pages URL once
  the project exists (`https://zero-lite.pages.dev` as the intended
  default).

No GitHub Actions workflow. Deploy is "connect the GitHub repo in the
Cloudflare Pages dashboard" (build command and output dir as above).

The static origin never includes a session token and never expects
`/rpc`. Lite is the only mode there.

## 9. Degradation

Same global rule: the editor never breaks because intelligence is
unavailable.

| Failure | Behavior |
|---|---|
| No `showDirectoryPicker` | Landing copy: Chrome or Edge required |
| Picker cancelled | Stay on landing |
| Permission not granted on restore | Landing with Reopen |
| Handle stale (folder moved) | Drop record, return to landing |
| Nano missing / download pending | Completions and chat off; pill names the reason; editing works |
| Search hits time or size cap | Partial `truncated: true` results |
| `FileSystemObserver` missing | 3s poll |
| Unimplemented RPC called | `-32601`, no throw out of the router |

Daemon-loss behavior (reconnect banner, read-only) is unchanged and does
not apply to Lite.

## 10. Testing

No real directory picker and no Chrome Nano in CI.

- **`browserFs.test.ts`:** a fake `FileSystemDirectoryHandle` tree in
  memory. Cover read/write/tree, create/rename/delete/move/copy, `..`
  rejection, `.git` / `node_modules` omission, gitignore, search
  truncation.
- **`localRpc.test.ts`:** real `RpcClient` over the in-process socket.
  `session/hello` flags, `fs/read` round-trip, unknown method → `-32601`.
- **`chatHost.test.ts`:** stub `ModelProvider`; `chat/turn` streams
  events; write tool emits `approvalRequest` and does not mutate until
  `chat/approve`; `run_command` is not registered.
- **`sessionStore.test.ts`:** sessions isolated by `rootId`.
- **Workbench test:** `capabilities.pty === false` does not add the
  terminal panel or terminal commands.
- **`createCompletion` Lite path:** providers/context lists contain Nano
  and `BufferContext` only.

Daemon tests stay green and do not import `packages/web/src/lite`.

## 11. Docs and version

- README Status: add M6 (Zero Lite) as implemented once the work lands.
  Note Chrome/Edge + Nano, no terminal/LSP, Pages URL.
- `docs/plugins.md`: no change (Lite does not load daemon plugins).
- Version: minor bump (`0.6.0`) at the end of the implementation plan,
  matching "new flavour" rather than a polish patch.

## 12. Implementation sketch

Bottom-up, each slice testable:

1. Protocol: `session/hello` types. Daemon implements the full-capability
   response. Workbench calls it and respects flags (daemon path still
   shows everything).
2. `BrowserFSWorkspace` + tests against fake handles.
3. `localRpc` + landing + handle persistence. `App` branches.
4. Watch + gitignore + search caps.
5. Lite completion factory.
6. Session store + chat host + Lite tools.
7. Workbench command/panel omissions verified.
8. Pages config + README + version bump.

## 13. Non-goals recap for implementers

Do not introduce `WorkspaceProvider` in core. Do not import Node/Bun APIs
into `@zero/core` or `@zero/protocol`. Do not import `@zero/daemon` into
`@zero/web`. Do not call Ollama from the page. Do not ship a second HTML
entry. Do not add a CI deploy workflow.
