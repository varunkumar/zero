# M5: Zero Agents

Date: 2026-08-07

## Context

M0-M4 (v1 scope: skeleton, offline completion, editor shell, terminal/LSP,
Graphify, chat/AgentRuntime) are implemented on `main`. Per the roadmap in
[the design spec](2026-08-04-zero-design.md#13-roadmap), M5 is:

> AgentRuntime daemon-side with Ollama/cloud models; write tools with
> approval gates, command execution via PTY service, headless `zero agent
> "task"` CLI, git checkpointing. Model gateway lands here.

Today `AgentRuntime` (`@zero/core`) runs **in the browser**, instantiated by
`packages/web/src/chatSetup.ts`. Its tools (`packages/web/src/chatTools.ts`)
are all read-only and call the daemon over RPC (`fs_read`, `fs_tree`,
`fs_search`, `graph_query`, `lsp_hover`, `lsp_definition`). There is no
git integration anywhere in the repo, and no CLI beyond starting the
daemon.

M5 needs the agent to also run **headless** (no browser) for the CLI, which
means the runtime itself must move to the daemon. Everything else in this
spec — write tools, approval, checkpointing, the CLI, the model gateway —
builds on that relocation.

This spec covers `@zero/core`, `@zero/daemon`, and `packages/web`'s chat
wiring. No `@zero/protocol` message *types* change in kind (still JSON-RPC
request/response and server-pushed events), but new RPC methods and event
types are added.

## 1. AgentRuntime moves to the daemon

`AgentRuntime` relocates to run inside `packages/daemon`, one instance per
active chat session. The class shape in `@zero/core` is unchanged (still
takes injected `providers`, `tools`, `client`, `workspace` — no DOM/Node
APIs, per the project's isomorphic-core constraint); only *where it's
instantiated* changes.

- `packages/web/src/chatSetup.ts` is deleted. `packages/web/src/chatTools.ts`
  is deleted from web and its tool *definitions* move into
  `packages/daemon/src/chatTools.ts`, now calling daemon services
  in-process instead of over RPC.
- The browser's `ChatPanel` becomes a thin client:
  - `chat/turn` (new RPC method) sends `{sessionId, userText}` and the
    daemon streams back `TurnEvent`s (`text`, `toolCall`, `toolResult`,
    `approvalRequest` — new, see §2 — `done`, `error`) as server-pushed
    events tagged with a turn id, the same pattern already used for PTY
    output and LSP diagnostics.
  - `ChatPanel` renders those events exactly as `AgentRuntime.sendMessage`'s
    consumer does today; the only new UI is the approval dialog (§2).
- The daemon owns one `AgentRuntime` per session, constructed lazily on
  first `chat/turn` and cached for the session's lifetime (mirrors how
  `pty.ts` keeps one PTY per terminal session).

## 2. Write tools + approval gate protocol

Three new tools, registered daemon-side alongside the existing read-only
ones:

- `fs_write(path, content)` — create/overwrite a file.
- `fs_edit(path, oldText, newText)` — find/replace edit against exact text,
  to keep diffs minimal (mirrors how targeted-edit tools work elsewhere,
  rather than requiring full-file rewrites).
- `run_command(command, cwd?)` — executes via the existing PTY service
  (`packages/daemon/src/pty.ts`), captures combined stdout/stderr and exit
  code as the tool result.

All three are gated by one shared approval step added to `AgentRuntime`'s
tool-execution loop:

1. Before executing a gated tool call, the runtime emits
   `{type: "approvalRequest", call, preview}` — `preview` is a unified diff
   for `fs_write`/`fs_edit`, the literal command string for `run_command` —
   and suspends that call pending a response.
2. The runtime awaits an `approvalResponse` from whichever client is
   driving the session:
   - Browser: `ChatPanel` shows a dialog, sends `chat/approve
     {sessionId, callId, approved}` over RPC.
   - CLI: since the embedded daemon has no separate client, the CLI's own
     process resolves this in-process — prompts `y/N` on stdin, or
     auto-resolves `true` immediately if `--yes` was passed (§4).
3. A denial resolves the tool call with result `"denied by user"`, fed back
   to the model like any other tool result — no special-cased error path,
   the model just sees the denial and can adapt.
4. No allowlist/denylist for `run_command` — approval is the only gate,
   same trust boundary as a human typing into the terminal panel.

Read-only tools (`fs_read`, `graph_query`, `lsp_hover`, etc.) skip approval
entirely, unchanged from M4.

## 3. Git checkpointing

New `packages/daemon/src/gitCheckpoint.ts`, shelling out to the `git`
binary (no library dependency, consistent with how `pty.ts` already shells
out rather than wrapping a PTY library).

A linked `git worktree` was considered and rejected: a worktree has its own
separate working directory, so committing there would never see the files
write tools actually change in the real workspace root. Instead this uses
git plumbing against the main repo with an **alternate index file**, which
commits the real working tree's current state onto a shadow branch without
ever touching the user's `HEAD`, checked-out branch, or staging area:

- On the first checkpoint in a session, if `.git` doesn't exist at the
  workspace root, checkpointing is disabled for the session (see
  degradation below) — no `git init` is performed, this only checkpoints
  workspaces that are already git repos.
- Each checkpoint runs, with `GIT_INDEX_FILE` pointed at a private index
  under `.zero/checkpoints/<sessionId>/index` (so the user's real staging
  area is never touched) and `GIT_DIR`/working directory set to the
  workspace root:
  1. `git add -A` — stages the current working tree into the alternate
     index.
  2. `git write-tree` — writes a tree object for that index, independent
     of any branch.
  3. `git commit-tree <tree> -p <parent> -m <message>` — creates a commit
     object with `<parent>` being the shadow branch's previous commit
     (`refs/heads/zero/agent-checkpoints/<sessionId>`), or the workspace's
     `HEAD` at session start if this is the first checkpoint.
  4. `git update-ref refs/heads/zero/agent-checkpoints/<sessionId>
     <commit>` — moves the shadow branch to the new commit. `HEAD` and the
     user's actual branch/index are never touched by any of these steps.
- Runs after each **approved** write/command tool call that changed files
  (`fs_write`, `fs_edit` unconditionally; `run_command` only if step 1's
  `git add -A` actually staged something), with a message like `agent:
  fs_edit src/foo.ts (turn <n>, call <m>)`.
- Purely a safety net for M5 — no UI to browse or restore checkpoints.
  Recoverable via `git log`/`git checkout` against the shadow branch (a
  normal branch, browsable with any git tool) if needed. Checkpoint
  browsing/restore UI is explicitly deferred to a later milestone.
- If git is missing, `.zero/checkpoints` isn't writable, or the workspace
  isn't a git repo, checkpointing degrades to a no-op with a one-time
  logged warning — write tools keep working regardless, per the project's
  "degrade the failing subsystem only" constraint (write tools are never
  gated on git being available).

## 4. Headless CLI: `zero agent "task"`

New `packages/daemon/src/cli/agent.ts`, added as a subcommand of the
existing `zero` bin:

```
zero agent "task description" [--yes] [--session <id>] [path]
```

- Instantiates the daemon's internals in-process — workspace root is
  `path` or cwd — **without** binding a WebSocket/HTTP server. No port, no
  browser. Reuses the exact same `AgentRuntime`, tool set, provider list,
  and `gitCheckpoint` module as the browser path; only the transport
  differs (direct function calls vs. RPC-over-WebSocket).
- Creates (or resumes, with `--session <id>`) a session in the existing
  `.zero/sessions/` store from M4, so `zero agent` runs remain visible and
  resumable from the browser chat panel if one is later opened against the
  same project.
- Streams `TurnEvent`s to stdout: assistant text as it arrives, `[tool]
  fs_edit src/foo.ts` lines for tool calls, `y/N` prompts on stdin for
  approval requests. `--yes` auto-approves every request instead of
  prompting.
- If stdin isn't a TTY and `--yes` wasn't passed, an approval request fails
  fast with a clear error (`"approval required but stdin is not
  interactive; pass --yes"`) rather than hanging.
- Single-shot: runs until the turn naturally completes (model stops
  requesting tools) or hits `MAX_TOOL_ROUNDS`, then exits — 0 on success,
  non-zero on error or abort. No interactive multi-turn chat loop in the
  CLI for M5; that's what the browser is for.

## 5. Model gateway

New `packages/daemon/src/modelGateway.ts`: an **Anthropic Messages
API-compatible** HTTP server (`POST /v1/messages`, SSE streaming and
non-streaming) the daemon can optionally bind on its own port, alongside
its existing WebSocket/static server. This matches section 9 of the base
design spec, which already specifies `/v1/messages` as the shape so that
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude` can point Claude Code
itself at the daemon (M7) — M5 stands up the gateway and wire format;
M7 adds the browser-Nano reverse-RPC bridge behind it. Building the
Anthropic-shaped surface now, rather than OpenAI's, avoids a rewrite when
M7 lands.

- Request/response translation (Anthropic `messages` + `system` + `tools`
  wire format, `content` blocks, `tool_use`/`tool_result` blocks,
  `message_start`/`content_block_delta`/... SSE event synthesis) lives in
  `@zero/core` as a shared translation layer, since M7's Nano bridge reuses
  it verbatim per the base spec — M5 only needs the subset that maps
  cleanly onto providers with native chat support (`OpenAICompatProvider`/
  Ollama, cloud providers); Nano-specific constrained-decoding tool-call
  emulation is out of scope until M7.
- Backed by the same configured provider list and the same selection logic
  `AgentRuntime` uses internally. That logic (`AgentRuntime`'s private
  `#pick()`) is extracted into a standalone, testable `ProviderGateway`
  class in `@zero/core`, used by both `AgentRuntime` and the HTTP endpoint.
- Purely an externally-facing surface for M5 — not wired into the chat
  panel or the CLI's own turn loop. Tool-calling *is* supported on this
  endpoint where the backing provider supports it natively (unlike a pure
  OpenAI-shaped gateway would need emulation for); Nano's constrained-JSON
  tool-call emulation is M7 scope.
- Off by default, enabled via `zero --gateway-port <port>`, binds
  `127.0.0.1` only. Requires an API key: generated on first use, stored at
  `.zero/gateway-key`, required as `x-api-key` (matching Anthropic's own
  header, so `ANTHROPIC_API_KEY=<key>` works unmodified with Claude Code)
  on every request. A port that accepts arbitrary chat requests is a
  stronger target than the existing session-token-gated WebSocket, so it
  gets its own credential rather than reusing the session token.

## 6. Error handling

- Gateway and CLI both bind `127.0.0.1` only, consistent with the existing
  daemon constraint (see §5 for the gateway's additional API-key
  requirement).
- Tool failures (bad path, non-zero exit, git checkpoint failure) are
  returned as normal tool-result strings, not thrown errors, so the model
  sees and can react to them — matches the existing read-only tool pattern
  from M4.
- Checkpoint failures degrade to a no-op (see §3); they never block a
  write tool from completing.
- CLI approval on non-interactive stdin without `--yes` fails fast (see
  §4) rather than hanging indefinitely.

## 7. Testing

Per-package, following the existing `*.test.ts`-next-to-module convention:

- **`@zero/core`**: unit tests for the approval suspend/resume flow in
  `AgentRuntime`, extending `agentRuntime.test.ts` with fake tools/
  providers; unit tests for the extracted `ProviderGateway` selection
  logic.
- **`@zero/daemon`**:
  - `gitCheckpoint.test.ts` against a real temp git repo: shadow branch
    creation, per-call commits, graceful degradation when git is missing.
  - RPC-level tests for `chat/turn` streaming and `chat/approve`.
  - An integration test driving `zero agent "task"` end-to-end against a
    stub provider with `--yes`, asserting exit code and checkpoint commits
    land.
  - HTTP tests for `modelGateway.ts`'s `/v1/messages` against a stub
    provider (request translation, SSE event synthesis, non-streaming),
    including the `x-api-key` check.
- No new Playwright E2E flow required for M5 — the existing chat E2E flow
  from M4 covers browser-side turn rendering; a manual smoke pass of the
  new approval dialog in `ChatPanel` is sufficient since the underlying
  protocol (§2) is unit-tested at the RPC layer.
