# Zero

[![Cloudflare Pages](https://img.shields.io/github/check-runs/varunkumar/zero/main?logo=cloudflare&logoColor=white&label=Cloudflare%20Pages)](https://dash.cloudflare.com/0d39754e3ae6404682a9bd4980eb399a/workers/services/view/zero-lite/production/builds)

<p align="center">
  <img src="docs/assets/zero-logo-dark.png" alt="Zero" width="320">
</p>

Zero is a local-first coding environment. The primary use case is coding fully
offline: you write code by hand with copilot-style inline completions from an
on-device model, plus an integrated terminal and a chat panel for asking
about the codebase.

Zero is a platform with one core engine and multiple flavours built on it:

- **Zero (v1)** - browser UI plus a local daemon: editor, completions,
  terminal, LSP, Graphify context, chat, and a daemon-side plugin host
  (built-in git status/blame and TODO/FIXME scanner plugins, each able to
  contribute their own browser UI).
- **Zero Agents** - the `zero` CLI, no browser required: an interactive TUI
  (`zero`) and a headless mode (`zero -p`) for scripts/CI, both over the same
  engine, with write tools, git checkpointing, and a model gateway.
- **Zero Lite** - pure-browser, zero-install flavour; no daemon, browser APIs
  only.
- **Zero Claude Plugin** - exposes Gemini Nano on Chrome as a model that
  Claude Code can be pointed at, enabling a fully offline Claude Code.
- **Zero VS Code Plugin** - VS Code extension for offline inline completions
  against a `zero serve` daemon, and a `vscode.lm` chat model provider
  backed by the same engine.
- **Zero IDE** - desktop app (Tauri) wrapping the same client and daemon.

Full design and roadmap:
[`docs/superpowers/specs/2026-08-04-zero-design.md`](docs/superpowers/specs/2026-08-04-zero-design.md).

## Status

M0 through M8.5 - the full roadmap - are implemented on `main`:

- **M0** skeleton (daemon-served editor with save)
- **M1** offline copilot (Chrome Nano + Ollama-compatible fallback)
- **M1.5** editor shell (workbench, tabs, palette, search, themes)
- **M2** terminal (PTY) and LSP (diagnostics, hover, go-to-definition)
- **M3** Graphify and plugin host - tree-sitter code graph indexer feeding
  completion context
- **M4** chat / AgentRuntime - turn loop, session persistence, read-only
  tool calling, chat panel (completes v1 scope)
- **M5** Zero Agents - write tools, git checkpointing, headless CLI, model gateway
- **M6** Zero Lite - no-daemon browser flavour, live at [zero.varunkumar.dev](https://zero.varunkumar.dev)
- **M7** Zero Claude Plugin - offline Claude Code via Gemini Nano/Ollama
- **M7.5a** Zero VS Code Plugin - offline completions in VS Code
- **M7.6** Zero VS Code Plugin - registers Zero as a `vscode.lm` chat model provider
- **M8** Zero IDE (core wrap) - `packages/desktop` Tauri desktop app
- **M8.5** Zero IDE polish - native menus/dock integration, multi-window
  support, sidecar startup-hang timeout

Each milestone's implementation details live in its design doc, listed
under [Design and plugin docs](#design-and-plugin-docs). See the
[full design spec](docs/superpowers/specs/2026-08-04-zero-design.md) for
the complete roadmap.

### Design and plugin docs

- [Zero design](docs/superpowers/specs/2026-08-04-zero-design.md)
- [M3 design](docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md)
- [M4 design](docs/superpowers/specs/2026-08-06-m4-chat-agentruntime-design.md)
- [M5 design](docs/superpowers/specs/2026-08-07-m5-zero-agents-design.md)
- [M7 design](docs/superpowers/specs/2026-08-13-m7-zero-claude-plugin-design.md)
- [M7.5a design](docs/superpowers/specs/2026-08-14-m7.5-vscode-completions-design.md)
- [M7.6 design](docs/superpowers/specs/2026-08-14-m7.6-vscode-lm-provider-design.md)
- [M8 design](docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md)
- [M8.5 design](docs/superpowers/specs/2026-08-18-m8.5-zero-ide-polish-design.md)
- [Plugins](docs/plugins.md)
- [Releasing](docs/releasing.md)

## Architecture

Bun monorepo:

```
zero/
  packages/
    core/        # @zero/core     - isomorphic engine (no DOM, no Node APIs)
    protocol/    # @zero/protocol - shared JSON-RPC message and event types
    daemon/      # @zero/daemon   - Node/Bun capability server
    web/         # @zero/web      - browser client
    vscode/      # zero-vscode    - VS Code inline-completions extension
    desktop/     # zero-desktop   - Tauri desktop app (Zero IDE)
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
  management, **plugin host** (Graphify indexer, git status/blame, TODO/FIXME
  scanner - each independently toggleable and able to serve its own browser
  UI bundle), session store, and static serving of the client. See
  [`docs/plugins.md`](docs/plugins.md).

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
- `zero serve [path] [--port <port>] [--gateway-port <port>]` - start the
  web daemon (editor/terminal/chat over HTTP/WS). Both ports default to a
  dynamically assigned free port; pass `0` explicitly for the same
  behavior, or a specific port to pin it. When `--gateway-port` is given,
  the daemon writes `<path>/.zero/zero.json` with `{mainPort, gatewayPort,
  gatewayApiKey}` so other tools (like the VS Code extension) can discover
  it without guessing a port.
- `zero claude [path] [--gateway-port <port>]` - start the daemon, bridging
  Claude Code to Gemini Nano running in an attached browser tab
- `zero --version` - print the installed version

## Zero Lite

Open **[zero.varunkumar.dev](https://zero.varunkumar.dev)** (or build locally:
`bun run --cwd packages/web build && bunx vite preview --cwd packages/web`)
in Chrome or Edge. Click Open folder and pick a project. Gemini Nano
powers completions and chat. There is no terminal and no language server.

`zero serve` is unchanged and does not offer Lite.

The badge at the top tracks the `Workers Builds: zero-lite` check on `main`,
the Cloudflare Pages build of `packages/web`. Green means the latest
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
serves as the Nano host at a time: whichever is currently in the
foreground; closing or backgrounding it hands off to another open Zero tab
if one exists. Nano is a small model: expect a working offline agent, not
cloud-Claude parity on tool-choice accuracy.

## Zero VS Code Plugin

Install the `zero` CLI (see [CLI usage](#cli-usage)), then package and
install the extension:

```
bun run --cwd packages/vscode package
code --install-extension packages/vscode/zero-vscode-*.vsix
```

Open any folder in VS Code; the extension finds or starts a `zero serve`
daemon scoped to that folder and shows the active model in the status bar.
See [`packages/vscode/README.md`](packages/vscode/README.md) for details.

## Development

```
bun install
bun test        # run all package tests
bun run typecheck
```

Requires Bun >= 1.1. All packages are TypeScript strict, ESM only.
