# Zero

Local-first coding environment: offline copilot-style completions, terminal,
and chat over one shared engine, with online capabilities layered on later.
System diagram tying the packages below together: `docs/architecture.md`.
Product lineup and install instructions: `README.md`.

## Layout

Each package's README is the reference for that component - read it before
making non-trivial changes there.

- `packages/protocol` (`@zero/protocol`) - shared JSON-RPC message/event
  types, Zod-validated at the boundary. `packages/protocol/README.md`.
- `packages/core` (`@zero/core`) - isomorphic engine: model/context/workspace/
  tool interfaces, CompletionEngine, AgentRuntime. `packages/core/README.md`.
- `packages/daemon` (`@zero/daemon`) - Bun/Node process: workspace fs, PTY,
  LSP, plugin host (Graphify indexer, git status/blame, TODO/FIXME scanner),
  session store, static serving. `packages/daemon/README.md`.
- `packages/web` (`@zero/web`) - React + CodeMirror 6 + xterm.js browser
  client. `packages/web/README.md`.
- `packages/vscode` (`zero-vscode`) - VS Code extension: offline inline
  completions against a per-folder `zero serve` daemon.
  `packages/vscode/README.md`.
- `packages/desktop` (`zero-desktop`) - Tauri v2 desktop wrap (Zero IDE):
  bundles `@zero/daemon` as a sidecar, opens `packages/web` in a native
  window. `packages/desktop/README.md`.

## Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs.
  All capabilities are injected (ModelProvider, ContextProvider,
  WorkspaceProvider, ToolProvider).
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session
  token are rejected (localhost alone is not a sufficient guard).
- The editor must stay fully usable when no model is available - degrade the
  failing subsystem only, never break editing.
- Token estimate convention: `Math.ceil(chars / 4)`.
- Completion budgets: 150ms keystroke debounce, 50ms context-gather budget,
  one completion request in flight at a time.
- Runtime floor: Bun >= 1.1.

## Commands

```
bun install
bun test          # all package tests
bun run typecheck # bunx tsc -b
```

## Working style

- Commit after each coherent unit of work; conventional-commit style
  messages.
- New behavior needs tests alongside it (see `*.test.ts` next to each
  module) - `@zero/core` in particular expects dense unit coverage with
  injected fakes rather than real DOM/Node dependencies.
- Cutting a release: `docs/releasing.md` (or the `/release` skill).
