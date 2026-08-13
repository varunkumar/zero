# Zero

[![Cloudflare Pages](https://img.shields.io/github/check-runs/varunkumar/zero/main?logo=cloudflare&logoColor=white&label=Cloudflare%20Pages)](https://dash.cloudflare.com/0d39754e3ae6404682a9bd4980eb399a/workers/services/view/zero-lite/production/builds)

<p align="center">
  <img src="docs/assets/zero-logo-dark.png" alt="Zero" width="320">
</p>

Zero is a local-first coding environment. The primary use case is coding fully
offline: you write code by hand with copilot-style inline completions from an
on-device model, plus an integrated terminal and a chat panel for asking
about the codebase. Online capabilities come later and are strictly additive.

Zero is a platform with one core engine and multiple flavours built on it:

- **Zero (v1)** - browser UI plus a local daemon: editor, completions,
  terminal, LSP, Graphify context, chat.
- **Zero Agents** - headless autonomous agent runs over the same engine.
- **Zero Lite** - pure-browser, zero-install flavour; no daemon, browser APIs
  only.
- **Zero Claude Plugin** - exposes Gemini Nano on Chrome as a model that
  Claude Code can be pointed at, enabling a fully offline Claude Code.
- **Zero IDE** - desktop app wrapping the same client and daemon.

Full design and roadmap:
[`docs/superpowers/specs/2026-08-04-zero-design.md`](docs/superpowers/specs/2026-08-04-zero-design.md).

## Status

M0–M5 are implemented on `main`:

- **M0** skeleton (daemon-served editor with save)
- **M1** offline copilot (Chrome Nano + Ollama-compatible fallback)
- **M1.5** editor shell (workbench, tabs, palette, search, themes)
- **M2** terminal (PTY) and LSP (diagnostics, hover, go-to-definition)
- **M3** Graphify and plugin host (in-process built-ins, tree-sitter index,
  `graph/*` RPC, `.zero/graph.json` cache, `GraphContext` for completions)
- **M4** chat / AgentRuntime (turn loop, layered system prompt, session
  persistence, token ledger, pruning/compaction, read-only tool calling,
  chat panel) — completes v1 scope
- **M5** Zero Agents (daemon-side AgentRuntime, approval-gated write tools
  `fs_write`/`fs_edit`/`run_command`, git checkpointing to a shadow branch,
  headless `zero -p "task"` CLI, Anthropic Messages API-compatible model
  gateway) — Nano is not yet wired into daemon-side runs; that lands with
  the M7 Nano bridge
- **M6** Zero Lite (same workbench, no daemon): open a local folder in
  Chrome or Edge, Nano completions and chat, no terminal/LSP/graph/git.
  Static hosting: Cloudflare Pages project `zero-lite` (connect the GitHub
  repo in the dashboard). Build command: `bun install && bun run --cwd
  packages/web build`. Output directory: `packages/web/dist`. Live at
  [zero.varunkumar.dev](https://zero.varunkumar.dev).
- **M7** Zero Claude Plugin (Nano bridge): `zero claude [path]` starts the
  daemon with its model gateway always on and prints an
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` line. Open the printed URL in
  Chrome or Edge to attach that tab as the Nano host — reverse-RPC lets the
  daemon call into it, running `ChromeNanoProvider` in-browser and emulating
  tool calls via Prompt API constrained JSON decoding. Point
  `ANTHROPIC_BASE_URL` at the printed gateway and run `claude` for a fully
  offline Claude Code. Falls back to the Ollama-compatible provider when no
  tab is attached.

Design and plugin docs:

- [M3 design](docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md)
- [M4 design](docs/superpowers/specs/2026-08-06-m4-chat-agentruntime-design.md)
- [M5 design](docs/superpowers/specs/2026-08-07-m5-zero-agents-design.md)
- [M7 design](docs/superpowers/specs/2026-08-13-m7-zero-claude-plugin-design.md)
- [Plugins](docs/plugins.md)

See the design spec for the full roadmap (Nano bridge, Claude plugin, Zero IDE,
and beyond).

## Architecture

Bun monorepo:

```
zero/
  packages/
    core/        # @zero/core     - isomorphic engine (no DOM, no Node APIs)
    protocol/    # @zero/protocol - shared JSON-RPC message and event types
    daemon/      # @zero/daemon   - Node/Bun capability server
    web/         # @zero/web      - browser client
  docs/
```

`zero [path]` opens an interactive terminal UI rooted at a project directory.
`zero serve [path]` starts the daemon instead: it indexes the project and
serves the web client at `http://localhost:<port>`, with the browser
connecting back over one WebSocket carrying JSON-RPC both ways. Everything
works with the network unplugged. See [CLI usage](#cli-usage) below for the
full command surface.

- **Browser**: CodeMirror 6 editor, the completion engine and AgentRuntime
  (from `@zero/core`), chat panel, xterm.js terminal UI, settings, and the
  Chrome Nano provider.
- **Daemon**: file system, project watching, PTY sessions, LSP server
  management, **plugin host** (built-ins first; Graphify indexer), session
  store, and static serving of the client. See [`docs/plugins.md`](docs/plugins.md).

## CLI usage

Install a `zero` command onto `~/.local/bin`:

```
./scripts/install.sh
```

Command surface:

- `zero [path]` - interactive TUI, new session
- `zero --resume [path]` - interactive TUI, pick a session to resume
- `zero -p "task" [--yes] [--session <id>] [path]` - run one task
  headlessly (for scripts/CI)
- `zero serve [path] [--gateway-port <port>]` - start the web daemon
  (editor/terminal/chat over HTTP/WS)
- `zero claude [path] [--gateway-port <port>]` - start the daemon, bridging
  Claude Code to Gemini Nano running in an attached browser tab
- `zero --version` - print the installed version

## Zero Lite

Open **[zero.varunkumar.dev](https://zero.varunkumar.dev)** (or build locally:
`bun run --cwd packages/web build && bunx vite preview --cwd packages/web`)
in Chrome or Edge. Click Open folder and pick a project. Gemini Nano
powers completions and chat. There is no terminal and no language server.

`zero serve` is unchanged and does not offer Lite.

The badge at the top tracks the `Workers Builds: zero-lite` check on `main`
— the Cloudflare Pages build of `packages/web`. Green means the latest
`main` build passed and published `dist/`; red or pending is the current
build, not a static "deployed" label.

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

## Development

```
bun install
bun test        # run all package tests
bun run typecheck
```

Requires Bun >= 1.1. All packages are TypeScript strict, ESM only.
