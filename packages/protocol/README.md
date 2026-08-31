# `@zero/protocol`

Shared JSON-RPC message and event types for everything that talks to the
`@zero/daemon` WebSocket: `packages/web`, `packages/vscode`, and the daemon
itself. The only package every other package in the monorepo can depend on.

## What's here

- `src/messages.ts` - request/response/event schemas, one Zod schema per
  RPC method (`fs/*`, `pty/*`, `lsp/*`, `graph/*`, `plugin/*`, `chat/*`,
  `agent/*`, `settings/*`, ...). Zod validates every message at the
  boundary - a malformed message is rejected before it reaches daemon or
  client logic.
- `src/client.ts` - a typed WebSocket client wrapper: request/response
  correlation by id, event subscription, reconnect handling.
- `src/index.ts` - the public export surface.

## Rules

- No DOM or Node/Bun APIs - this package must stay usable from the daemon
  (Bun), the browser (`packages/web`), and VS Code's extension host
  equally.
- Adding an RPC method means adding its Zod schema here first, then
  implementing the handler in `@zero/daemon` and the call site in whichever
  client needs it.
- Breaking a message shape breaks every client at once - prefer additive
  changes (new optional fields, new methods) over renaming/removing.
