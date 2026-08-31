# `@zero/daemon`

The Bun/Node process behind Zero and Zero Agents: everything a browser tab
or the `zero` CLI can't do for itself. Binds `127.0.0.1` only; WebSocket
connections without the session token are rejected regardless of origin.

## What's here

- `server.ts`, `rpc.ts`, `main.ts` - HTTP + WebSocket server, JSON-RPC
  dispatch against `@zero/protocol` schemas, static serving of the built
  `packages/web` client.
- `workspace.ts` - sandboxed filesystem access (no path traversal outside
  the opened folder, respects ignore files).
- `pty.ts` - PTY session management for the integrated terminal.
- `lsp/` - per-language LSP server registry, spawning, and client protocol
  glue (`registry.ts`, `service.ts`, `client.ts`).
- `plugins/` - the **plugin host**: in-process TypeScript modules that
  register RPC methods and context providers over the same WebSocket. See
  `plugins/host.ts` and `plugins/types.ts` for the host API, and each
  subdirectory for a built-in:
  - `plugins/graphify/` - tree-sitter structural indexer, incremental
    updates, `graph/*` RPC, `GraphContext` data.
  - `plugins/git/` - git status/blame.
  - `plugins/todos/` - TODO/FIXME scanner.
- `agentClient.ts`, `agentRuntimePool.ts`, `chatTools.ts`, `modelGateway.ts`,
  `nanoBridgeProvider.ts`, `nanoHost.ts` - wires `@zero/core`'s
  `AgentRuntime` and model providers into the daemon process, including the
  Chrome-tab bridge used by the Zero Claude Plugin.
- `cli/` - the `zero` CLI itself: the interactive TUI (`cli/tui/`),
  headless `-p` mode (`cli/agent.ts`), and the Claude Code bridge
  (`cli/claude.ts`).
- `sessions.ts` - session persistence (for `zero --resume`).
- `gitCheckpoint.ts`, `diffPreview.ts`, `execCommand.ts` - agent-side tool
  implementations (checkpointing, diff generation, shell execution).

## Plugin host details

Full plugin manifest shape, host RPC, and how to add a new built-in or a
tree-sitter grammar: `../../docs/plugins.md`.
