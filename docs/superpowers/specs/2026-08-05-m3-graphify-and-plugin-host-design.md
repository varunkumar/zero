# M3 Graphify and Plugin Host — Design

Date: 2026-08-05
Status: Draft for review
Branch / worktree: `worktree-m3-graphify-and-plugin-host` under
`.claude/worktrees/m3-graphify-and-plugin-host`

Per the roadmap (`docs/superpowers/specs/2026-08-04-zero-design.md` section 13),
M3 is: plugin host, Graphify indexer as first built-in, GraphContext, graph
query tools (as RPC surface for M4), and an eval harness proving context
quality. This document is the design session output for that milestone.

M2 (terminal and LSP) may land in parallel on a separate worktree. M3 does not
depend on M2 and must not own PTY/LSP surfaces.

## 1. Scope

### In scope

- **Plugin host (daemon, in-process, minimal):** load built-in plugins only;
  real manifest + contribution registry; no `~/.zero/plugins` scan yet.
- **Graphify built-in plugin:** tree-sitter incremental indexer producing a
  graph compatible with the graphify-out schema (files, symbols, imports,
  call/reference edges). Full index on first open in the background;
  incremental on `fs/changed` / saves.
- **Grammar registry:** data-driven language map. **Bundled and tested:**
  TypeScript and JavaScript. **User-addable via settings:** Java, Python, Go,
  Rust, and others (command/path to grammar package or WASM module).
- **Protocol:** `graph/*` and minimal `plugin/*` RPC types.
- **`GraphContext`** in `@zero/core` for completions (50ms budget, same
  pattern as planned `LspContext`).
- **Web wiring:** inject GraphContext into the completion engine; status bar
  indexer health; settings UI for grammar registry overrides.
- **Fixture-based context eval** under `bun test` (no model in the loop).
- **Docs:** README status/architecture updates; `docs/plugins.md` describing
  the host and how a future built-in or user plugin would contribute.

### Out of scope (explicit)

- Scanning or hot-loading `~/.zero/plugins` (post-M3).
- Worker / process isolation for plugins (M8-era hardening).
- Chat UI, AgentRuntime tool loop, and executable ToolProvider wiring (M4).
  M3 still shapes stable `graph/query` so M4 can wrap tools without a protocol
  redesign.
- Semantic / LLM extraction (Python graphify “deep” mode). Structural
  tree-sitter only.
- Bundling tree-sitter grammars for Java, Python, etc. in M3 (registry must
  accept them; packages are user- or follow-up-supplied).
- Graph visualization UI (`graph.html` viewer) inside Zero.
- Replacing or depending on the external Python `graphifyy` CLI.
- PTY, LSP, or any M2-owned modules.

## 2. Decisions (from design session)

| Topic | Choice |
|---|---|
| Indexer | Embed tree-sitter in the daemon (no Python runtime) |
| Plugin host location | Daemon-side, in-process for v1 |
| Plugin host depth | Minimal: built-ins only, real API |
| Languages | Grammar registry; TS/JS bundled |
| Graph tools | Context + query/status RPC only; M4-ready |
| Eval | Fixture-based unit eval in CI |
| Overall shape | Thin host + Graphify as daemon plugin module (Approach 1) |

## 3. Architecture

```
@zero/web                          @zero/core                    @zero/daemon
─────────                          ──────────                    ────────────
CompletionEngine                   GraphContext ──RPC──►         PluginHost
  + BufferContext                    (gather only)                 ├─ built-ins list
  + GraphContext (injected)                                        └─ GraphifyPlugin
  + (LspContext when M2 lands)                                       ├─ Indexer (tree-sitter)
                                                                     ├─ GraphStore
Workbench: indexer health                                            └─ query / contextAt / status
Settings: graphify.grammars
```

**Layering (bottom-up, consistent with M0–M2):**

1. `@zero/protocol` — plain TypeScript interfaces for graph and plugin
   messages (daemon-side Zod validates at the boundary, matching existing
   `Fs*` / `Settings*` style if M2 has not already introduced a different
   convention on the branch being merged).
2. `@zero/daemon` — `PluginHost`, Graphify plugin (indexer, store, handlers).
3. `@zero/core` — `GraphContext` implements `ContextProvider`; injected
   `{ request }` client only (no Node/DOM).
4. `@zero/web` — engine wiring, status, settings.

**Degradation:** a slow or failed index never breaks editing. `GraphContext`
returns `[]` when the index is cold, missing, or times out; health is
flagged. BufferContext and typing remain unaffected.

**Parallel with M2:** shared merge points are protocol re-exports, daemon
method registration in `main.ts`, completion provider list, and status bar.
No shared ownership of new M2 files.

## 4. Plugin host

### 4.1 Location and lifecycle

- Lives in `@zero/daemon` (`packages/daemon/src/pluginHost.ts` or
  `packages/daemon/src/plugins/host.ts`).
- Constructed at daemon start with the workspace root and a broadcast
  function.
- Loads the built-in list (hard-coded array of factory functions). M3 list:
  `[createGraphifyPlugin]`.
- Each plugin receives a `PluginContext`: `{ root, broadcast, workspace }`
  (workspace is the existing `Workspace` for safe reads; plugins must not
  bypass path containment).
- Plugins run **in-process**. A plugin throw during `activate` is caught,
  logged, and surfaces as unhealthy in `plugin/list`; it must not crash the
  daemon.

### 4.2 Manifest

```typescript
interface PluginManifest {
  id: string;           // e.g. "graphify"
  name: string;         // human label
  version: string;      // semver string
  contributions: {
    /** Daemon RPC methods this plugin registers (documentation + list UI). */
    rpcMethods?: string[];
    /** Context provider ids exposed to the client (e.g. "graph"). */
    contextProviders?: string[];
    /** Tool names reserved for M4 ToolProvider wrapping (declared early). */
    tools?: string[];
    /** Command ids for future command palette contributions. */
    commands?: string[];
  };
}
```

### 4.3 Plugin interface

```typescript
interface ZeroPlugin {
  manifest: PluginManifest;
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
  /** Optional health for status bar aggregation. */
  health?(): PluginHealth;
}

interface PluginHealth {
  ok: boolean;
  detail?: string;
}
```

Built-ins call `daemon.rpc.register(...)` during `activate` (or the host
passes a scoped registrar). Prefer a **scoped registrar** so the host can
track which methods belong to which plugin and unregister on deactivate.

### 4.4 Host RPC (minimal)

| Method | Purpose |
|---|---|
| `plugin/list` | `{ plugins: { id, name, version, health, contributions }[] }` |
| `plugin/health` | aggregate `{ ok, plugins: Record<string, PluginHealth> }` |

No install/uninstall/reload RPCs in M3.

### 4.5 What is deferred

- `~/.zero/plugins` discovery and dynamic `import()`.
- Browser-side plugin manifests (ChromeNano stays client-registered).
- Contribution of model providers via manifest (not needed until M5+).

## 5. Graphify plugin

### 5.1 Layout

```
packages/daemon/src/plugins/
  host.ts                 # PluginHost
  types.ts                # ZeroPlugin, PluginManifest, PluginContext
  graphify/
    index.ts              # createGraphifyPlugin()
    indexer.ts            # tree-sitter walk + incremental updates
    store.ts              # in-memory graph + optional disk persist
    query.ts              # neighborhood / symbol lookup
    grammars.ts           # registry: languageId → grammar module
    contextAt.ts          # purpose-built for GraphContext
```

### 5.2 Graph model (graphify-out compatible)

Target on-disk / export shape aligns with existing `graphify-out/graph.json`
node-link JSON so external graphify outputs remain readable if we add an
optional seed load later (not required for M3 correctness).

**Nodes (minimum fields):**

| Field | Meaning |
|---|---|
| `id` | Stable id: `{parent}_{stem}_{symbol}` style, lowercase `[a-z0-9_]` |
| `label` | Human-readable name |
| `file_type` | `"code"` for structural nodes in M3 |
| `source_file` | Workspace-relative path |
| `source_location` | Optional `L{line}` or `L{line}:C{col}` |
| `kind` | Optional: `file` \| `module` \| `function` \| `class` \| `method` \| `variable` \| `type` |

**Edges (minimum fields):**

| Field | Meaning |
|---|---|
| `source` / `target` | Node ids |
| `relation` | `contains` \| `imports` \| `calls` \| `references` \| `extends` \| `implements` |
| `confidence` | `"EXTRACTED"` for tree-sitter edges |
| `confidence_score` | `1.0` for EXTRACTED |
| `source_file` | Where the edge was observed |

In-memory store may use adjacency maps for query speed; serialization uses the
node-link document above.

### 5.3 Indexer behavior

1. **Startup:** after workspace is ready, schedule a background full index
   (do not block WebSocket accept or static serving).
2. **File set:** same visibility rules as `Workspace.tree()` / search
   (gitignore, skip `.git`, `.zero`, `node_modules`, binary).
3. **Per file:** pick grammar by extension / languageId from the registry;
   skip unknown languages; parse with tree-sitter; extract:
   - file node
   - top-level and nested declarations (functions, classes, methods, types)
   - import edges (resolved relatively when possible; otherwise edge to a
     module stub node keyed by specifier)
   - call edges within the file when the callee is a known local symbol;
     cross-file calls when simple name resolution finds a unique export
4. **Incremental:** on `fs/changed` for a path, re-parse that file, remove
   nodes/edges with `source_file === path`, merge new fragment. Deletes:
   prune all nodes/edges for that path.
5. **Debounce:** coalesce rapid saves (e.g. 100–200ms) per path.
6. **Persist (optional but recommended):** write
   `.zero/graph.json` (gitignored via `.zero/`) after full index and
   periodically after incremental batches so restart is warm. Do **not**
   require writing into the user’s `graphify-out/` (that directory is the
   external tool’s domain).

### 5.4 Grammar registry

Default bundled map (M3):

| languageId | Extensions | Grammar package |
|---|---|---|
| `typescript` | `.ts`, `.tsx` | `tree-sitter-typescript` (typescript + tsx) |
| `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs` | `tree-sitter-javascript` (or TS grammar’s JS mode if cleaner) |

Settings key (daemon-backed, via existing settings store):

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

Exact settings shape is fixed in the implementation plan; principle: **add a
language without code changes to the host**, only dependency availability and
a settings entry. If a configured module fails to load, that language is
skipped and health detail names it.

**Java and other languages:** supported by the registry contract in M3;
bundling and CI coverage for them is follow-up. Docs in `docs/plugins.md`
show a Java example entry.

### 5.5 Tree-sitter binding

Use a Bun/Node-compatible binding (prefer `web-tree-sitter` with WASM
grammars if native `node-tree-sitter` is awkward under Bun; pick one in the
implementation plan after a spike of ≤ half a day). Criterion: works under
`bun test` on macOS/Linux without a separate compile step for contributors
if feasible.

## 6. Protocol

Plain interfaces in `packages/protocol/src/messages.ts` (and re-export from
`index.ts`).

### 6.1 Graph

```typescript
/** Cursor position, 0-based line/character (LSP-style). */
interface GraphPosition { line: number; character: number }

interface GraphContextAtParams {
  path: string;
  position: GraphPosition;
  /** Soft cap on returned chunks; daemon may return fewer. */
  maxChunks?: number;
}
interface GraphContextChunk { text: string; score: number; source?: string }
interface GraphContextAtResult { chunks: GraphContextChunk[]; ready: boolean }

interface GraphQueryParams {
  /** Free-text or symbol name; exact match preferred, then substring. */
  q: string;
  /** Optional: "neighbors" | "symbol" | "path" — default neighbors of best symbol hit. */
  mode?: "neighbors" | "symbol" | "path";
  budgetTokens?: number;
}
interface GraphQueryResult {
  nodes: { id: string; label: string; source_file?: string; kind?: string }[];
  edges: { source: string; target: string; relation: string }[];
  text: string;  // preformatted context block for M4 tools / debugging
}

interface GraphStatusResult {
  ready: boolean;
  indexing: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError?: string;
  languages: string[];  // active grammar languageIds
}

// Events (broadcast)
interface GraphStatusEvent {
  ready: boolean;
  indexing: boolean;
  nodeCount?: number;
  edgeCount?: number;
}
```

| Method | Handler owner |
|---|---|
| `graph/contextAt` | Graphify |
| `graph/query` | Graphify |
| `graph/status` | Graphify |
| `plugin/list` | PluginHost |
| `plugin/health` | PluginHost |

Event: `graph/status` (optional push on index start/finish; clients may also
poll `graph/status`).

### 6.2 M4 handoff

M4 will define tools roughly as:

- `graph_query` → `graph/query`
- (optional) `graph_neighbors` → `graph/query` with `mode: "neighbors"`

Manifest `contributions.tools` lists `["graph_query"]` so `plugin/list`
documents the reservation. No tool execution in M3.

## 7. GraphContext (`@zero/core`)

```typescript
export interface GraphContextClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

export class GraphContext implements ContextProvider {
  name = "graph";
  constructor(private client: GraphContextClient) {}

  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    // Derive a rough position from prefix (line/character count), or accept
    // extended request fields when the web layer supplies them.
    const result = await this.client.request<GraphContextAtResult>(
      "graph/contextAt",
      { path: req.path, position: positionFromPrefix(req.prefix), maxChunks: 6 },
    );
    if (!result.ready) return [];
    return result.chunks.map((c) => ({
      source: c.source ?? "graph",
      text: c.text,
      score: c.score,
      tokenCost: estimateTokens(c.text),
    }));
  }
}
```

**Position derivation:** M3 may extend `CompletionRequest` with optional
`position?: { line; character }` supplied by the web editor (preferred). If
absent, estimate from `prefix` (count `\n` and last-line length). Do not
require M2 LSP types.

**Scoring heuristic for `contextAt` (daemon):**

| Chunk content | Score band |
|---|---|
| Symbol under / enclosing cursor | 0.9–1.0 |
| Direct imports of current file | 0.7–0.85 |
| Callees / callers one hop | 0.55–0.75 |
| Same-file sibling symbols | 0.4–0.55 |

Each chunk text is a short excerpt (signature + a few lines or edge summary),
token-capped so the 50ms gather + prompt builder stay healthy. Prefer fewer
high-score chunks over dumping the whole neighborhood.

## 8. Web client

- Register `GraphContext` alongside `BufferContext` in the completion engine
  setup (same place M1 wires providers).
- Status bar: indexer ready / indexing / error (from `graph/status` or
  `graph/status` events). Failure degrades only this subsystem.
- Settings panel section **Graphify**: show active languages; advanced JSON
  or structured fields for `graphify.grammars` overrides (can reuse generic
  settings path if a full form is heavy).
- Toggle to disable GraphContext (settings flag) without removing the plugin.

## 9. Eval harness

Fixture tree under e.g. `packages/daemon/src/plugins/graphify/fixtures/mini-repo/`:

- Small TS files with known imports and calls.
- Test: run indexer on fixture root → `contextAt` at a fixed position →
  assert chunk texts include expected symbol names / import targets.
- Test: `graph/query` for a symbol returns expected neighbor set.
- Test: unknown language file is skipped without failing the index.
- Test: plugin host lists graphify; simulate activate failure isolation with
  a test double plugin if useful.

All under `bun test`. No LLM, no network.

## 10. Dependencies

| Package | Purpose |
|---|---|
| tree-sitter binding + WASM or native | parsing |
| `tree-sitter-typescript` / `tree-sitter-javascript` | bundled grammars |

No Python. No new UI framework libraries.

## 11. Documentation (this milestone)

| Doc | Change |
|---|---|
| `README.md` | Status: M3 in progress / describe plugin host + Graphify; point to `docs/plugins.md`. |
| `docs/plugins.md` | **New.** Plugin host model, manifest shape, built-ins, how to add a grammar, M4 tool reservation notes. |
| Design + plan under `docs/superpowers/` | This file + implementation plan after approval. |

## 12. Error handling and health

- Indexer errors on a single file: skip file, continue, record last error
  string (path + message) for status.
- Grammar load failure: disable that languageId, do not crash host.
- Plugin activate failure: mark plugin unhealthy; other plugins continue.
- `graph/contextAt` while indexing: return `{ ready: false, chunks: [] }` or
  best-effort partial graph if store is non-empty (prefer partial if nodeCount
  \> 0 so completions improve before full finish).
- RPC validation failures: standard JSON-RPC error codes via existing rpc
  layer.

## 13. Testing strategy

| Layer | Tests |
|---|---|
| protocol | Round-trip / shape tests for new interfaces |
| plugin host | register built-in, list, isolate failing plugin |
| indexer | fixture mini-repo extraction counts and edges |
| query / contextAt | golden neighborhood for fixture positions |
| GraphContext (core) | fake client; maps chunks; empty when not ready |
| daemon integration | startZero-style wire test for `graph/status` + `contextAt` |
| web | light test or manual for status slot if pure UI |

## 14. Implementation order (plan outline)

1. Protocol types + tests  
2. Plugin host + `plugin/list` + `plugin/health`  
3. Graph store + query primitives (can start with hand-built graph in tests)  
4. Tree-sitter indexer + TS/JS grammars + incremental updates  
5. Graphify `activate` registers `graph/*`  
6. Persist `.zero/graph.json`  
7. `GraphContext` in core + web wiring + status + settings  
8. Fixture eval suite  
9. Docs (README + `docs/plugins.md`)  
10. Conventional commits per coherent unit  

## 15. Success criteria

- Fresh workspace: background index completes; `graph/status.ready === true`.
- Completions receive graph chunks for TS/JS symbols within the existing
  context budget when the index is warm.
- Editor remains usable with indexer disabled, crashed, or mid-index.
- `bun test` includes fixture evals that fail if context quality regresses
  on the mini-repo.
- `plugin/list` shows Graphify; docs describe how Java would be added via
  grammar settings.
- M4 can implement `graph_query` tool as a thin RPC wrapper with no protocol
  change beyond optional extras.

## 16. Open implementation spikes (not design forks)

Resolved during planning/implementation, not blocking design approval:

1. `web-tree-sitter` vs native binding under Bun.
2. Whether `CompletionRequest` gains optional `position` in M3 (recommended:
   yes).
3. Exact npm package names/versions for grammars.

