# M7: Zero Claude Plugin (Nano Bridge)

Date: 2026-08-13
Status: Approved

Per the roadmap (`docs/superpowers/specs/2026-08-04-zero-design.md` section 13),
M7 is: an Anthropic-compatible Nano bridge per section 9. Goal: set Gemini
Nano on Chrome as the model Claude Code uses, for a fully offline Claude
Code.

M0-M6 are on `main`. The M5 model gateway (`packages/daemon/src/modelGateway.ts`)
already serves `POST /v1/messages`, does SSE, and synthesizes `tool_use`
blocks, translating through `@zero/core`'s `anthropicTranslate.ts`. That
layer is provider-agnostic today; the gap is that no daemon-side
`ChatCapableProvider` resolves to Nano, because Nano only exists inside a
browser (`packages/daemon/src/main.ts`'s `buildProviders()` comment: "Nano
is deliberately excluded here... Nano-backed daemon-side runs are M7...
scope").

## 1. Scope

### In scope

- **Reverse-RPC**: the daemon can issue a request to one specific connected
  browser client and await a streamed, typed reply. First instance of this
  pattern in the codebase; wire format is unchanged (existing
  `RpcRequest`/`RpcResponse`/`RpcNotification` are already directionless).
- **`NanoHostRegistry`** (daemon): tracks connected browser tabs that have
  registered as Nano-capable, ordered by recency, always routing to the
  most-recently-registered (foreground) one, with automatic handoff/fallback
  on disconnect.
- **Web-side Nano host**: in daemon mode (not Lite), a tab with Nano ready
  registers itself while visible, answers reverse `nano/chat` calls by
  running `ChromeNanoProvider` locally, and streams results back.
- **`NanoBridgeProvider`** (daemon): a `ChatCapableProvider` backed by the
  registry, wired only into the model gateway's `ProviderGateway`.
- **Constrained-decoding tool emulation** (`@zero/core`): builds a
  `responseConstraint` JSON schema from `ChatToolSpec[]`, parses Nano's
  constrained JSON output into `ChatDelta` (text or `toolCalls`).
- **`ChromeNanoProvider.chat()` fix**: real session reuse (only the new turn
  is sent per call, not the whole flattened transcript every time); wires in
  constrained decoding when tools are present; `supportsTools()` returns
  `true`.
- **`zero claude [path]`** launcher CLI: starts the daemon + gateway (like
  `zero serve`), prints the URL to open and the `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_API_KEY` env line, polls and reports Nano-host attachment
  status, stays running.
- **`GET /health`** on the model gateway: `{ nanoHostConnected, provider }`.

### Out of scope (explicit)

- Daemon-launched headless/app-mode Chrome "Nano host" page. This milestone
  only reuses an already-open Zero tab. A launched host is a future
  follow-up if the reuse-only flow proves insufficient.
- Wiring constrained-decoding tool emulation into `AgentRuntime` /
  `chat/turn` (the in-app chat panel and `zero agent`). Nano stays
  `supportsTools()===false` on that path; M7 only affects the `/v1/messages`
  bridge's own `ProviderGateway` instance.
- `stream:false` (non-streaming) support in the model gateway — remains
  unimplemented, as before M7.
- Zero VS Code Plugin (M7.5) and anything beyond the bridge itself.
- Multiple simultaneous *daemons* sharing one Nano host, or one browser tab
  serving multiple daemons.

## 2. Decisions (from design session)

| Topic | Choice |
|---|---|
| Reaching Nano | Reuse an already-open Zero client (no headless launch) |
| Tool calling | Constrained JSON decoding via `responseConstraint` |
| AgentRuntime | Untouched; bridge-only scope |
| No host connected | Return an Anthropic-shaped error immediately, no waiting |
| `ChromeNanoProvider.chat()` | Fix session reuse as part of this milestone |
| Launcher | `zero claude`, reuses `zero serve`'s daemon + gateway |
| Multiple tabs | Foreground tab wins, auto-managed via page visibility |

## 3. Architecture

```
Chrome/Edge tab (already open, zero serve)          Terminal
──────────────────────────────────────────          ────────
RpcClient (existing daemon socket)                   ANTHROPIC_BASE_URL=http://127.0.0.1:<gw-port>
  + probes Nano, registers while visible              ANTHROPIC_API_KEY=<key> claude
  + answers reverse "nano/chat" requests               │
  + streams deltas back as "nano/chatDelta" notifs     ▼
        ▲            │                          POST /v1/messages (existing modelGateway.ts, unchanged)
        │            ▼                                │
   daemon: NanoHostRegistry (new)  ◄────────────  ProviderGateway.pick()
   ordered set of registered sockets,                  │
   routes to most-recently-registered              NanoBridgeProvider (new, ChatCapableProvider)
                                                     .chat() → NanoHostRegistry reverse-RPC
```

Everything downstream of `ChatCapableProvider.chat()` (SSE synthesis,
`tool_use` block assembly, the `/v1/messages` handler itself) is unchanged.
M7's work is entirely: (1) get a `ChatCapableProvider` backed by a live
browser, and (2) let that browser answer tool-calling turns despite Nano
having no native tool head.

## 4. Reverse-RPC

No new wire-format types. `RpcRequest`/`RpcResponse`/`RpcNotification`
(`packages/protocol/src/messages.ts`) already model both directions; only
`RpcClient` and `RpcServer` assumed one direction each. Additions:

- **`RpcClient`** (`packages/protocol/src/client.ts`):
  - `onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void` —
    when an incoming message has both `id` and `method` (today `RpcClient`
    only expects `id`+`result`/`error` or bare `method` notifications from
    the server), look up a registered handler, await it, and send back
    `{jsonrpc:"2.0", id, result}` or `{jsonrpc:"2.0", id, error}` over the
    same socket. Unregistered incoming requests get an error response
    (`-32601`), matching `RpcServer`'s existing unknown-method behavior.
  - `notify(method: string, params?: unknown): void` — sends
    `{jsonrpc:"2.0", method, params}` with no `id` (fire-and-forget),
    mirroring the daemon's `broadcast`.

- **`RpcServer`** (`packages/daemon/src/rpc.ts`):
  - `registerNotification(method: string, handler: (params: unknown) => void): void` —
    today `dispatch()` returns `null` for any message without an `id`
    (client notifications are silently dropped, per the existing comment
    `// client notifications: none yet`). Extend `dispatch()` to check this
    map before dropping.
  - `dispatch(raw: string, ctx?: { ws: Bun.ServerWebSocket<unknown> }): Promise<string | null>` —
    gains an optional second parameter threaded to registered handlers as
    `fn(params, ctx)`. Existing `(params) => ...` handlers stay valid: a
    function accepting fewer parameters than its declared type is
    assignable in TS, so none of the ~15 existing `daemon.rpc.register`
    call sites in `main.ts` need to change. This lets `nano/register`/
    `nano/unregister` (section 6) be ordinary registered methods that read
    `ctx.ws`, instead of needing special-casing outside `RpcServer`.

- **`server.ts`** (`packages/daemon/src/server.ts`): the `websocket.message`
  handler currently always calls `rpc.dispatch(raw)`. Extend it to first
  classify the parsed message:
  - Has `method` → existing behavior, now `rpc.dispatch(raw, { ws })`
    (covers both requests and, via the new map, notifications).
  - Has `result` or `error`, no `method` → a response to a daemon-initiated
    reverse request; resolve it from a pending map (keyed by the id the
    daemon generated when it sent the reverse request) instead of calling
    `rpc.dispatch`.
  - Add `requestSocket<R>(ws, method, params?): Promise<R>` on the daemon
    handle: allocates an id from a monotonic counter (a separate id space
    from whatever ids clients pick for their own requests — the two are
    never compared against each other, only matched by message *shape*,
    so no collision is possible even if the numbers coincide), sends
    `{id, method, params}` to that one `ws`, and stores
    `{resolve, reject, ws}` in the pending map. On that socket's `close`,
    reject every pending entry whose `ws` matches it. Also add
    `onSocketClose(fn: (ws) => void): void` on the daemon handle so
    `NanoHostRegistry` (section 5) can drop a socket the moment it
    disconnects, and expose the daemon's internal `sockets` set for tests.

This keeps the reverse path fully separate from the existing
client→daemon `RpcServer` dispatch table — no risk of method-name
collisions between the two directions, since a given incoming message is
either request-shaped (`method` present) or response-shaped (`result`/
`error` present, no `method`), never both, and the two flows are routed
by that shape check alone.

## 5. `NanoHostRegistry`

New `packages/daemon/src/nanoHost.ts`. Holds an ordered set of registered
sockets (registration order = recency, most recent last):

- `register(ws)`: append (moving `ws` to the end if already present).
- `unregister(ws)`: remove; also called automatically on that socket's
  `close`.
- `available(): boolean`: set is non-empty.
- `chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta>`:
  targets the last (most recent) socket in the set. Generates a
  `requestId`, calls `daemon.requestSocket(ws, "nano/chat", {requestId, messages, tools})`,
  and concurrently listens for `nano/chatDelta` notifications matching that
  `requestId` (registered via `RpcServer.registerNotification`), yielding
  each as a `ChatDelta`. Resolves when the reverse request's response
  arrives (`{requestId, done: true}`); if the request rejects (socket
  closed mid-flight), the iterable ends and the model gateway's existing
  stream-error path (`event: error`) handles it — no new error handling
  needed there.
- Throws (via the reverse request's rejection) if the set is empty when
  `chat()` is called; `NanoBridgeProvider.available()` should be checked by
  `ProviderGateway.pick()` first, so this is a defensive path, not the
  primary "no host" signal.

## 6. Web-side Nano host

New `packages/web/src/nanoHost.ts`, wired from wherever the daemon-mode
`RpcClient` is constructed (not in Lite mode — Lite has no daemon to
register with).

- On daemon-mode connect: probe Nano (`probeNano`, existing). If ready,
  and `document.visibilityState === "visible"`, call
  `client.request("nano/register")`.
- Register `client.onRequest("nano/chat", handler)` once, regardless of
  current visibility: `handler({requestId, messages, tools})` runs a local
  `ChromeNanoProvider.chat(messages, tools, signal)`, forwarding each
  `ChatDelta` via `client.notify("nano/chatDelta", {requestId, delta})`,
  then resolves the request with `{requestId, done: true}` once the
  iterable completes. `signal` comes from an `AbortController` this module
  owns per `requestId`, aborted if the tab is torn down mid-stream.
- `document.addEventListener("visibilitychange", ...)`:
  - → `"hidden"`: `client.notify("nano/unregister")` if previously
    registered (best-effort; no ack needed).
  - → `"visible"`: re-probe Nano and re-register if still ready.
- `window.addEventListener("beforeunload", ...)`: best-effort unregister
  notify (registry's `close` handling on the daemon side is the reliable
  path; this just reduces the disconnect-detection window).

Daemon side: `nano/register`/`nano/unregister` need the originating socket,
which plain `RpcServer.register` handlers don't receive today (handlers
only get `params`). Rather than special-casing these two methods outside
`RpcServer`, `RpcServer.dispatch` gains an optional second parameter,
threaded through from `server.ts`'s message handler where the raw `ws` is
in scope: `dispatch(raw: string, ctx?: { ws: Bun.ServerWebSocket<unknown> })`,
and registered handlers may now take `(params, ctx)` — TS's existing
`(params) => ...` handlers stay valid since a function accepting fewer
parameters than its declared type is assignable in TS, so none of the
existing ~15 `daemon.rpc.register` call sites in `main.ts` need to change.
`nano/register`/`nano/unregister` are then ordinary registrations in
`main.ts`, alongside the other `chat/*`/`fs/*` methods:

```ts
daemon.rpc.register("nano/register", z.object({}).optional().transform(() => ({})),
  async (_p, ctx) => { nanoHost.register(ctx!.ws); return {}; });
daemon.rpc.register("nano/unregister", z.object({}).optional().transform(() => ({})),
  async (_p, ctx) => { nanoHost.unregister(ctx!.ws); return {}; });
```

## 7. `NanoBridgeProvider`

New `packages/daemon/src/nanoBridgeProvider.ts`, implementing
`ChatCapableProvider` from `@zero/core`:

```ts
class NanoBridgeProvider implements ChatCapableProvider {
  id = "nano-bridge";
  constructor(private registry: NanoHostRegistry) {}
  async available() { return this.registry.available(); }
  capabilities() { return { id: this.id, supportsFim: false, contextWindowTokens: 6144 }; }
  supportsTools() { return true; }
  async *complete() { /* unused by the gateway; throw or return empty */ }
  chat(messages, tools, signal) { return this.registry.chat(messages, tools, signal); }
}
```

Added **only** to the `ProviderGateway` built for `startModelGateway`
(`packages/daemon/src/main.ts`, the `gatewayPort !== undefined` branch,
currently `buildProviders()` called a second time there). The
`chat/turn`/`AgentRuntime` provider list (the other `buildProviders()`
call) is untouched — satisfies "AgentRuntime untouched" from section 2.
`ProviderGateway.pick()`'s existing `available.find(p => p.supportsTools()) ?? available[0]`
means: if a Nano host is attached, it's preferred over Ollama for the
Claude Code bridge (both support tools, but Nano is listed first in this
gateway's provider array, ahead of the Ollama fallback) — that ordering
choice (Nano first when present) matches the milestone's whole point.

## 8. Constrained-decoding tool emulation

New `packages/core/src/providers/nanoTools.ts`:

- `buildToolResponseConstraint(tools: ChatToolSpec[]): object` — a JSON
  Schema for the Prompt API's `responseConstraint`, shaped as a tagged
  union: `{ type: "object", properties: { kind: {enum:["answer","tool_call"]}, text: {...}, tool: {enum: tools.map(t=>t.name)}, input: {...} }, ... }`.
  Exact schema dialect accepted by Chrome's Prompt API will be verified
  against the installed Chrome version during implementation (task-level
  concern, not a design blocker); if `anyOf`/`enum` combinations it needs
  aren't supported, fall back to a flat object with an optional
  `tool`/`input` pair and `required: []`.
- `parseNanoToolResponse(raw: string, tools: ChatToolSpec[]): ChatDelta` —
  `JSON.parse`s the accumulated output; `kind === "tool_call"` → single
  `toolCalls: [{id: crypto.randomUUID(), name: tool, args: input}]`;
  otherwise → `{text}`. Parse failure (Nano ignored the constraint) →
  `{text: raw}`, treated as a plain answer rather than throwing — matches
  the system's stated "small-model capability limit, not plumbing" honesty
  (section 9 of the parent design).

`ChromeNanoProvider` changes (`packages/core/src/providers/chromeNano.ts`):

- `supportsTools()` **stays `false`** (unchanged). That flag is what
  `AgentRuntime` and `ProviderGateway.pick()` consult to decide whether to
  offer tools to a provider at all; flipping it would silently turn on
  tool-calling for every existing `ChromeNanoProvider` consumer, including
  Lite's in-browser `AgentRuntime` — outside this milestone's scope (section
  2: "AgentRuntime untouched"). Instead, `chat()` itself honors whatever
  `tools` array it's given, independent of `supportsTools()`: the bridge
  path (`NanoBridgeProvider`, section 7) always passes real tools and gets
  constrained decoding; any other caller that (today) never passes tools
  keeps getting plain streamed text, unchanged.
- Session reuse: track `#sentCount` (how many of the last-seen `messages`
  have already been sent to the live session). On `chat()`, if
  `messages.length < #sentCount` (a new/reset conversation), destroy and
  recreate the session; otherwise only `prompt()`/`promptStreaming()` the
  messages from `#sentCount` onward, then update `#sentCount = messages.length`.
  This replaces the current full-transcript-flattening on every call.
- When `tools.length > 0`: call with `{responseConstraint: buildToolResponseConstraint(tools)}`,
  accumulate the full streamed output (constrained JSON isn't safely
  parsed mid-stream), then `yield parseNanoToolResponse(full, tools)` once
  as a single `ChatDelta` at the end — no incremental text deltas for
  tool-eligible turns. When `tools.length === 0`, behavior is unchanged
  (token-by-token `{text}` deltas).

## 9. `zero claude` launcher

New `packages/daemon/src/cli/claude.ts`, mirroring `cli/agent.ts`'s shape
(`positionalArgs`, `parseGatewayPort` reused as-is):

- `zero claude [path] [--gateway-port <port>]`: resolves `root`, calls
  `startZero({root, port: 4820, webDist, gatewayPort: parsedGatewayPort ?? 0})`
  exactly like the `serve` branch (port `0` auto-picks when not given —
  `zero serve` today requires an explicit `--gateway-port` to enable the
  gateway at all; `zero claude` always enables it).
- Prints:
  ```
  zero ready: http://127.0.0.1:<port>/?token=<token>
  Open that URL in Chrome or Edge to attach Gemini Nano.

  ANTHROPIC_BASE_URL=http://127.0.0.1:<gw-port> ANTHROPIC_API_KEY=<key> claude
  ```
- Polls `GET /health` on the gateway (or, simpler, exposes the registry's
  `available()` via the returned daemon handle directly in-process — no
  need for an HTTP round trip since this is the same process) every ~1s,
  printing `waiting for a Zero tab with Gemini Nano...` until attached,
  then `Nano host attached ✓`, then stays running (like `serve`) until
  Ctrl+C. Re-prints attach/detach transitions if the host disconnects and
  reconnects later.
- `bin/zero.ts` gets a new `argv[0] === "claude"` branch alongside `serve`,
  reusing `positionalArgs`/`parseGatewayPort` the same way the `serve`
  branch does. `--help` text gains a `zero claude [path]` line.

`GET /health` added to `modelGateway.ts`: returns
`{ nanoHostConnected: boolean, provider: string | null }` by calling
`opts.gateway.pick()` speculatively (`available: true` branch) — mainly
for external scripting/health checks; the CLI itself uses the in-process
registry handle directly as noted above.

## 10. No-host behavior

Unchanged code path: `modelGateway.ts`'s existing
`if (!provider) return new Response("no model available", { status: 503 })`
already covers "no `ChatCapableProvider` available," which is exactly what
`NanoBridgeProvider.available()` reports when the registry is empty. If the
host disconnects *mid-stream* (after `pick()` succeeded), the registry's
reverse request rejects, the `for await` in `modelGateway.ts` throws, and
the existing `catch` block's `event: error` SSE frame carries the message —
also unchanged code.

## 11. Testing

Matches M5/M6's TDD shape — dense unit coverage with fakes, one integration
test per new wire-level behavior:

- `RpcClient.onRequest`/`notify`: fake-socket tests alongside the existing
  ones in `packages/protocol/src/client.test.ts` (incoming request →
  handler invoked → response sent; unregistered method → error response).
- `RpcServer.registerNotification` + `server.ts`'s reverse dispatch:
  extend `packages/daemon/src/server.test.ts` with a `requestSocket`
  round-trip test (two fake/real sockets: one plays "browser," answers a
  reverse request) and a notification-delivery test.
- `NanoHostRegistry`: unit tests with fake sockets — registers, routes to
  most-recent, falls back on close, rejects `chat()` when empty.
- `nanoTools.ts`: schema-shape and parse round-trip tests, including the
  parse-failure-falls-back-to-text case.
- `ChromeNanoProvider`: extend `chromeNano.test.ts` with a fake
  `NanoSession` covering session-reuse (only new turns sent) and the
  tools-present constrained-parse path.
- `NanoBridgeProvider` + full bridge: one integration test through a real
  `createDaemon`/`startModelGateway` pair plus two real `WebSocket`s (one
  acting as the browser, answering `nano/chat` with a scripted reply),
  exercising a full `/v1/messages` round trip end to end — same style as
  `packages/daemon/src/main.test.ts`'s existing chat/turn tests.
- `zero claude` CLI: argv-parsing unit tests (`positionalArgs`,
  `parseGatewayPort` already covered; add coverage for the new branch
  dispatch in a `cli/claude.test.ts` if `bin/zero.ts` logic is extracted
  enough to test, matching how `cli/agent.ts` is tested independently of
  `bin/zero.ts`).

## Self-review (spec coverage)

| Topic | Section |
|---|---|
| Reverse-RPC (protocol/daemon) | 4 |
| Multi-tab host selection, visibility | 5, 6 |
| Web-side registration/answering | 6 |
| Nano as a gateway-only ChatCapableProvider | 7 |
| Constrained decoding / tool emulation | 8 |
| Session-reuse fix | 8 |
| Launcher CLI | 9 |
| No-host / mid-stream-disconnect handling | 10 |
| AgentRuntime untouched | 7 |
| Testing | 11 |
