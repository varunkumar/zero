# Plugins

Zero’s **plugin host** runs inside the local daemon (`@zero/daemon`). Plugins
are TypeScript modules that activate in-process and contribute capabilities
over the same JSON-RPC WebSocket the editor already uses.

This document describes the **M3** model: a real host API with **built-in
plugins only**. Scanning `~/.zero/plugins` and worker isolation are later
work. Browser-only pieces (for example Chrome’s Gemini Nano provider) are
registered in client code, not via daemon manifests.

Design: [`docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md`](superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md).

## What a plugin is

A plugin has:

1. A **manifest** (`id`, `name`, `version`, `contributions`).
2. An **`activate(ctx)`** hook that registers RPC methods and starts
   background work.
3. Optional **`health()`** for the status bar and `plugin/health`.

### Manifest contributions

| Field | Meaning |
|---|---|
| `rpcMethods` | RPC method names this plugin registers (e.g. `graph/query`) |
| `contextProviders` | Context provider ids the client may enable (e.g. `graph`) |
| `tools` | Tool names **reserved for M4** AgentRuntime (declared early; not executed in M3) |
| `commands` | Future command-palette ids |

### Plugin context

On activate, the host passes roughly:

- `root` — workspace absolute path  
- `workspace` — safe FS API (same path rules as the editor: no traversal, respects ignore)  
- `broadcast` — push events to connected clients  
- a **scoped RPC registrar** so methods are tied to the plugin id  

Plugins must not read arbitrary filesystem paths outside the workspace API.

## Built-ins (M3)

| id | Role |
|---|---|
| `graphify` | Tree-sitter structural indexer, graph store, `graph/*` RPC, GraphContext data |

### Graphify

- **Index:** full project scan in the background on open; incremental updates
  on file change.
- **Languages:** data-driven grammar registry. **Bundled:** TypeScript and
  JavaScript. **Others (Java, Python, Go, …):** add via settings when a
  tree-sitter grammar package is available (see below).
- **Storage:** in-memory graph; warm cache under `.zero/graph.json` (gitignored
  with the rest of `.zero/`).
- **Schema:** compatible with the graphify-out node-link shape (nodes, links /
  edges, relations such as `imports`, `calls`, `contains`).
- **RPC:**
  - `graph/status` — ready / indexing / counts / errors  
  - `graph/contextAt` — chunks for inline completion (`GraphContext`)  
  - `graph/query` — neighborhood / symbol lookup for debugging and **M4 tools**  
- **Client:** `@zero/core` `GraphContext` gathers over RPC under the same
  ~50ms context budget as other providers. Failures yield no chunks; editing
  continues.

M4 is expected to wrap `graph/query` as a chat tool (e.g. `graph_query`)
without redesigning this protocol.

## Host RPC

| Method | Result |
|---|---|
| `plugin/list` | Installed plugins, manifests, health |
| `plugin/health` | Aggregate ok flag + per-plugin health |

## Adding a language grammar (settings)

Grammars are not hard-coded beyond the TS/JS defaults. Settings key
`graphify.grammars` (via `settings/get` / `settings/set` →
`~/.zero/settings.json`):

```json
{
  "graphify.grammars": {
    "java": {
      "extensions": [".java"],
      "module": "tree-sitter-java"
    }
  }
}
```

Requirements:

1. The grammar package (or WASM asset) must be resolvable by the daemon
   (installed dependency or configured path).
2. Extensions must not collide with an existing languageId unless you intend
   to override.
3. If the module fails to load, that language is skipped; Graphify health
   detail should name the failure. Other languages keep indexing.

## Future: user plugins

Not in M3. Planned direction:

- Discover packages under `~/.zero/plugins/<id>/` with a `package.json` /
  manifest.
- Same `ZeroPlugin` interface as built-ins.
- Still daemon-side; process isolation comes later.

Until then, new capabilities should land as additional **built-ins** in the
daemon repo or wait for user-plugin loading.

## Related packages

| Package | Role |
|---|---|
| `@zero/daemon` | Plugin host + Graphify implementation |
| `@zero/protocol` | Shared `graph/*` and `plugin/*` message types |
| `@zero/core` | `GraphContext` (`ContextProvider`) |
| `@zero/web` | Wires GraphContext into completions; status / settings UI |
