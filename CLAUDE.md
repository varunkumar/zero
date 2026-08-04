# Zero

Local-first coding environment: offline copilot-style completions, terminal,
and chat over one shared engine, with online capabilities layered on later.
Full vision and architecture: `docs/superpowers/specs/2026-08-04-zero-design.md`.
Current implementation plan: `docs/superpowers/plans/2026-08-04-m0-m1-skeleton-and-completion.md`.

## Layout

- `packages/protocol` (`@zero/protocol`) - shared JSON-RPC message/event
  types, Zod-validated at the boundary.
- `packages/core` (`@zero/core`) - isomorphic engine: model/context/workspace/
  tool interfaces, CompletionEngine, AgentRuntime.
- `packages/daemon` (`@zero/daemon`) - Bun/Node process: workspace fs, PTY,
  LSP, plugin host (Graphify first), session store, static serving.
- `packages/web` (`@zero/web`) - React + CodeMirror 6 + xterm.js browser
  client.

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
