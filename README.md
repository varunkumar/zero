# Zero

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
  headless `zero agent "task"` CLI, Anthropic Messages API-compatible model
  gateway) — Nano is not yet wired into daemon-side runs; that lands with
  the M7 Nano bridge

Design and plugin docs:

- [M3 design](docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md)
- [M4 design](docs/superpowers/specs/2026-08-06-m4-chat-agentruntime-design.md)
- [M5 design](docs/superpowers/specs/2026-08-07-m5-zero-agents-design.md)
- [Plugins](docs/plugins.md)

See the roadmap in the design spec for what follows (Zero Agents, Zero Lite,
Claude plugin, Zero IDE).

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

`zero [path]` starts the daemon in a project directory. The daemon indexes
the project and serves the web client at `http://localhost:<port>`. The
browser connects back over one WebSocket carrying JSON-RPC both ways.
Everything works with the network unplugged.

- **Browser**: CodeMirror 6 editor, the completion engine and AgentRuntime
  (from `@zero/core`), chat panel, xterm.js terminal UI, settings, and the
  Chrome Nano provider.
- **Daemon**: file system, project watching, PTY sessions, LSP server
  management, **plugin host** (built-ins first; Graphify indexer), session
  store, and static serving of the client. See [`docs/plugins.md`](docs/plugins.md).

## Development

```
bun install
bun test        # run all package tests
bun run typecheck
```

Requires Bun >= 1.1. All packages are TypeScript strict, ESM only.
