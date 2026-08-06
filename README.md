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

M0 (skeleton), M1 (offline copilot), M1.5 (editor shell), and M2 (terminal
and LSP) are implemented. M3 (Graphify and plugin host) is in progress on
this branch.

- **M3 design:**
  [`docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md`](docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md)
- **Plugins (daemon plugin host + Graphify):**
  [`docs/plugins.md`](docs/plugins.md)

See the roadmap in the design spec for what follows (chat/AgentRuntime, Zero
Agents, Zero Lite, Claude plugin, Zero IDE).

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
