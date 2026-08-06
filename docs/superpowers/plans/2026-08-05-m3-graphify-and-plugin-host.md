# M3 Graphify and Plugin Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal in-daemon plugin host and the Graphify built-in (tree-sitter structural indexer, graph store, `graph/*` RPC, `GraphContext` for completions, fixture eval) so completions get codebase graph context offline, and M4 can wrap `graph/query` as tools without a protocol redesign.

**Architecture:** Bottom-up, protocol → daemon plugin host + Graphify → core GraphContext → web wiring, matching M0/M1/M1.5 and the M2 plan style. `@zero/protocol` gains plain graph/plugin message interfaces (no Zod in protocol; daemon Zod validates). The daemon gets `PluginHost` (built-ins only) and `createGraphifyPlugin` (indexer, store, query, contextAt). `@zero/core` gets `GraphContext` with an injected `{ request }` client. `@zero/web` injects GraphContext into the completion engine and shows indexer health on the status bar. Work happens on branch `worktree-m3-graphify-and-plugin-host` under `.claude/worktrees/m3-graphify-and-plugin-host` (from `main`); do not touch M2 PTY/LSP files.

**Tech Stack:** `web-tree-sitter` + WASM grammars (`tree-sitter-typescript`, `tree-sitter-javascript`) for parsing under Bun without native compile steps; existing Zod + `Workspace` + `RpcServer`; Bun test. No Python.

**Design:** `docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md`  
**User-facing plugins doc:** `docs/plugins.md` (already drafted; Task 9 refreshes if APIs drift)

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs (from `CLAUDE.md`). `GraphContext` talks to the daemon only through an injected `{ request<R>(method, params?): Promise<R> }` interface.
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only; WebSocket connections without the session token are rejected.
- The editor must stay fully usable when the indexer is cold, disabled, or crashed — degrade only Graphify, never break editing.
- Token estimate convention: `Math.ceil(chars / 4)` (`estimateTokens` in `packages/core/src/tokens.ts`).
- Completion budgets: 150ms keystroke debounce, 50ms context-gather budget, one completion request in flight — `GraphContext.gather()` runs inside existing `gatherContext()` and must not change that budget.
- New behavior needs tests alongside it (`*.test.ts` next to each module); `@zero/core` expects dense unit coverage with injected fakes.
- Commit after each coherent unit of work; conventional-commit style messages.
- Plugin host is **in-daemon, in-process, built-ins only** — no `~/.zero/plugins` scan.
- Grammar registry: **TS/JS bundled and tested**; other languages (Java, …) via settings shape only in M3 (no bundled Java grammar package).
- No chat ToolProvider execution in M3; declare `tools: ["graph_query"]` on the Graphify manifest for M4.
- Do not implement PTY, LSP, or edit M2-owned modules if they appear after a merge; keep Graphify/plugin files under `packages/daemon/src/plugins/`.
- Persist graph cache under `.zero/graph.json` (already gitignored via `.zero/`), not `graphify-out/`.

## File map

| Path | Responsibility |
|---|---|
| `packages/protocol/src/messages.ts` | Graph + plugin message interfaces |
| `packages/daemon/src/plugins/types.ts` | `ZeroPlugin`, `PluginManifest`, `PluginContext`, `PluginHealth` |
| `packages/daemon/src/plugins/host.ts` | `PluginHost`: activate built-ins, list, health, scoped register |
| `packages/daemon/src/plugins/graphify/store.ts` | In-memory graph + serialize/deserialize |
| `packages/daemon/src/plugins/graphify/query.ts` | Symbol search + neighborhood → `GraphQueryResult` |
| `packages/daemon/src/plugins/graphify/contextAt.ts` | Cursor neighborhood → scored chunks |
| `packages/daemon/src/plugins/graphify/grammars.ts` | languageId/extension → WASM grammar loader |
| `packages/daemon/src/plugins/graphify/extract.ts` | Tree → nodes/edges for one file |
| `packages/daemon/src/plugins/graphify/indexer.ts` | Full + incremental index over workspace |
| `packages/daemon/src/plugins/graphify/index.ts` | `createGraphifyPlugin` + RPC registration |
| `packages/daemon/src/plugins/graphify/fixtures/mini-repo/` | Eval fixtures |
| `packages/daemon/src/main.ts` | Construct host, activate, wire fs/changed to indexer |
| `packages/core/src/graphContext.ts` | `GraphContext` provider |
| `packages/web/src/completionSetup.ts` | Inject GraphContext when client available |
| `packages/web/src/workbench/StatusBar.tsx` | Indexer health slot |
| `packages/web/src/workbench/layout/Workbench.tsx` | Poll/subscribe graph status; pass to StatusBar |
| `docs/plugins.md` / `README.md` | Align with shipped APIs |

---

### Task 1: Protocol — graph and plugin message types

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/messages.test.ts` (append)

**Interfaces:**
- Produces: `GraphPosition`, `GraphContextAtParams`, `GraphContextChunk`, `GraphContextAtResult`, `GraphQueryParams`, `GraphQueryResult`, `GraphStatusResult`, `GraphStatusEvent`, `PluginHealthInfo`, `PluginListEntry`, `PluginListResult`, `PluginHealthResult`.

- [ ] **Step 1: Append interfaces to `packages/protocol/src/messages.ts`**

```typescript
/** 0-based line/character (LSP-style). */
export interface GraphPosition { line: number; character: number }

export interface GraphContextAtParams {
  path: string;
  position: GraphPosition;
  maxChunks?: number;
}
export interface GraphContextChunk { text: string; score: number; source?: string }
export interface GraphContextAtResult { chunks: GraphContextChunk[]; ready: boolean }

export interface GraphQueryParams {
  q: string;
  mode?: "neighbors" | "symbol" | "path";
  budgetTokens?: number;
}
export interface GraphQueryResult {
  nodes: { id: string; label: string; source_file?: string; kind?: string }[];
  edges: { source: string; target: string; relation: string }[];
  text: string;
}

export interface GraphStatusResult {
  ready: boolean;
  indexing: boolean;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  lastError?: string;
  languages: string[];
}
export interface GraphStatusEvent {
  ready: boolean;
  indexing: boolean;
  nodeCount?: number;
  edgeCount?: number;
}

export interface PluginHealthInfo { ok: boolean; detail?: string }
export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  health: PluginHealthInfo;
  contributions: {
    rpcMethods?: string[];
    contextProviders?: string[];
    tools?: string[];
    commands?: string[];
  };
}
export interface PluginListResult { plugins: PluginListEntry[] }
export interface PluginHealthResult {
  ok: boolean;
  plugins: Record<string, PluginHealthInfo>;
}
```

- [ ] **Step 2: Append shape tests in `packages/protocol/src/messages.test.ts`**

```typescript
import type {
  GraphContextAtParams, GraphQueryResult, PluginListResult, GraphStatusResult,
} from "./messages";

test("graph and plugin types are plain JSON-serializable shapes", () => {
  const ctx: GraphContextAtParams = { path: "a.ts", position: { line: 0, character: 1 }, maxChunks: 4 };
  const q: GraphQueryResult = {
    nodes: [{ id: "a", label: "A", source_file: "a.ts", kind: "function" }],
    edges: [{ source: "a", target: "b", relation: "calls" }],
    text: "A calls b",
  };
  const st: GraphStatusResult = {
    ready: true, indexing: false, fileCount: 1, nodeCount: 2, edgeCount: 1, languages: ["typescript"],
  };
  const pl: PluginListResult = {
    plugins: [{
      id: "graphify", name: "Graphify", version: "0.1.0",
      health: { ok: true },
      contributions: { rpcMethods: ["graph/query"], contextProviders: ["graph"], tools: ["graph_query"] },
    }],
  };
  expect(JSON.parse(JSON.stringify({ ctx, q, st, pl }))).toEqual({ ctx, q, st, pl });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test packages/protocol`
Expected: PASS (including new test).

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): add graph and plugin message types"
```

---

### Task 2: Plugin host (built-ins only)

**Files:**
- Create: `packages/daemon/src/plugins/types.ts`
- Create: `packages/daemon/src/plugins/host.ts`
- Create: `packages/daemon/src/plugins/host.test.ts`

**Interfaces:**
- Consumes: `RpcServer` from `../rpc`, `Workspace` from `../workspace`, Zod for param schemas on host RPCs.
- Produces:
  - `PluginManifest`, `PluginHealth`, `PluginContext`, `ZeroPlugin` from `types.ts`
  - `PluginHost` with:
    - `constructor(opts: { rpc: RpcServer; workspace: Workspace; root: string; broadcast: (method: string, params: unknown) => void })`
    - `async activateBuiltins(factories: Array<(ctx: PluginContext) => ZeroPlugin | Promise<ZeroPlugin>>): Promise<void>`
    - `list(): PluginListResult` (from protocol types)
    - `health(): PluginHealthResult`
    - `registerHostRpcs(): void` — registers `plugin/list` and `plugin/health`

- [ ] **Step 1: Write failing tests**

Create `packages/daemon/src/plugins/host.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "../rpc";
import { Workspace } from "../workspace";
import { PluginHost } from "./host";
import type { PluginContext, ZeroPlugin } from "./types";

function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "zero-ph-"));
  const rpc = new RpcServer();
  const workspace = new Workspace(root);
  const broadcasts: { method: string; params: unknown }[] = [];
  const host = new PluginHost({
    rpc, workspace, root,
    broadcast: (method, params) => broadcasts.push({ method, params }),
  });
  host.registerHostRpcs();
  return { host, rpc, root, broadcasts };
}

test("activateBuiltins lists healthy plugin and registers its methods", async () => {
  const { host, rpc } = makeHost();
  const factory = (ctx: PluginContext): ZeroPlugin => {
    ctx.register("demo/ping", z.object({}), async () => ({ pong: true }));
    return {
      manifest: {
        id: "demo", name: "Demo", version: "1.0.0",
        contributions: { rpcMethods: ["demo/ping"] },
      },
      activate() {},
      health: () => ({ ok: true }),
    };
  };
  await host.activateBuiltins([factory]);
  const list = host.list();
  expect(list.plugins).toHaveLength(1);
  expect(list.plugins[0]!.id).toBe("demo");
  expect(list.plugins[0]!.health.ok).toBe(true);

  const raw = await rpc.dispatch(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "demo/ping", params: {},
  }));
  expect(JSON.parse(raw!).result).toEqual({ pong: true });

  const listRaw = await rpc.dispatch(JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "plugin/list", params: {},
  }));
  expect(JSON.parse(listRaw!).result.plugins[0].id).toBe("demo");
});

test("activate failure marks plugin unhealthy and does not throw", async () => {
  const { host } = makeHost();
  const bad = (): ZeroPlugin => ({
    manifest: { id: "bad", name: "Bad", version: "0.0.1", contributions: {} },
    activate() { throw new Error("boom"); },
  });
  await host.activateBuiltins([bad]);
  expect(host.list().plugins[0]!.health.ok).toBe(false);
  expect(host.list().plugins[0]!.health.detail).toContain("boom");
  expect(host.health().ok).toBe(false);
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test packages/daemon/src/plugins/host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types and host**

Create `packages/daemon/src/plugins/types.ts`:

```typescript
import type { z } from "zod";
import type { Workspace } from "../workspace";

export interface PluginHealth { ok: boolean; detail?: string }

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  contributions: {
    rpcMethods?: string[];
    contextProviders?: string[];
    tools?: string[];
    commands?: string[];
  };
}

export interface PluginContext {
  root: string;
  workspace: Workspace;
  broadcast: (method: string, params: unknown) => void;
  register: <P, R>(method: string, schema: z.ZodType<P>, fn: (params: P) => Promise<R>) => void;
}

export interface ZeroPlugin {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  health?(): PluginHealth;
}
```

Create `packages/daemon/src/plugins/host.ts`:

```typescript
import { z } from "zod";
import type { PluginHealthResult, PluginListResult } from "@zero/protocol";
import type { RpcServer } from "../rpc";
import type { Workspace } from "../workspace";
import type { PluginContext, PluginHealth, PluginManifest, ZeroPlugin } from "./types";

type Entry = {
  plugin: ZeroPlugin;
  health: PluginHealth;
};

export class PluginHost {
  #rpc: RpcServer;
  #workspace: Workspace;
  #root: string;
  #broadcast: (method: string, params: unknown) => void;
  #entries: Entry[] = [];

  constructor(opts: {
    rpc: RpcServer;
    workspace: Workspace;
    root: string;
    broadcast: (method: string, params: unknown) => void;
  }) {
    this.#rpc = opts.rpc;
    this.#workspace = opts.workspace;
    this.#root = opts.root;
    this.#broadcast = opts.broadcast;
  }

  registerHostRpcs(): void {
    this.#rpc.register("plugin/list", z.object({}).optional().transform(() => ({})),
      async () => this.list());
    this.#rpc.register("plugin/health", z.object({}).optional().transform(() => ({})),
      async () => this.health());
  }

  async activateBuiltins(
    factories: Array<(ctx: PluginContext) => ZeroPlugin | Promise<ZeroPlugin>>,
  ): Promise<void> {
    for (const factory of factories) {
      const ctx = this.#makeContext();
      let plugin: ZeroPlugin;
      try {
        plugin = await factory(ctx);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.#entries.push({
          plugin: {
            manifest: { id: "unknown", name: "unknown", version: "0", contributions: {} },
            activate() {},
          },
          health: { ok: false, detail },
        });
        continue;
      }
      try {
        await plugin.activate(ctx);
        this.#entries.push({
          plugin,
          health: plugin.health?.() ?? { ok: true },
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.#entries.push({ plugin, health: { ok: false, detail } });
      }
    }
  }

  #makeContext(): PluginContext {
    return {
      root: this.#root,
      workspace: this.#workspace,
      broadcast: this.#broadcast,
      register: (method, schema, fn) => this.#rpc.register(method, schema, fn),
    };
  }

  list(): PluginListResult {
    return {
      plugins: this.#entries.map(({ plugin, health }) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        health: this.#liveHealth(plugin, health),
        contributions: plugin.manifest.contributions,
      })),
    };
  }

  health(): PluginHealthResult {
    const plugins: Record<string, PluginHealth> = {};
    let ok = true;
    for (const { plugin, health } of this.#entries) {
      const h = this.#liveHealth(plugin, health);
      plugins[plugin.manifest.id] = h;
      if (!h.ok) ok = false;
    }
    return { ok, plugins };
  }

  #liveHealth(plugin: ZeroPlugin, cached: PluginHealth): PluginHealth {
    try {
      return plugin.health?.() ?? cached;
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test packages/daemon/src/plugins/host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/plugins/types.ts packages/daemon/src/plugins/host.ts packages/daemon/src/plugins/host.test.ts
git commit -m "feat(daemon): add minimal in-process plugin host"
```

---

### Task 3: Graph store + query + contextAt (no tree-sitter yet)

**Files:**
- Create: `packages/daemon/src/plugins/graphify/store.ts`
- Create: `packages/daemon/src/plugins/graphify/store.test.ts`
- Create: `packages/daemon/src/plugins/graphify/query.ts`
- Create: `packages/daemon/src/plugins/graphify/query.test.ts`
- Create: `packages/daemon/src/plugins/graphify/contextAt.ts`
- Create: `packages/daemon/src/plugins/graphify/contextAt.test.ts`

**Interfaces:**
- Produces:
  - `GraphNode { id, label, file_type, source_file, source_location?, kind? }`
  - `GraphEdge { source, target, relation, confidence, confidence_score, source_file }`
  - `class GraphStore` with `clear()`, `replaceFile(path, nodes, edges)`, `removeFile(path)`, `addNodes/Edges`, `getNode`, `nodes()`, `edges()`, `nodeCount`, `edgeCount`, `toJSON()`, `loadJSON(data)`, `neighbors(id, depth?)`
  - `queryGraph(store, params: GraphQueryParams): GraphQueryResult`
  - `contextAt(store, params: GraphContextAtParams): GraphContextChunk[]` (pure; caller sets `ready`)

- [ ] **Step 1: Write store tests**

Create `packages/daemon/src/plugins/graphify/store.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { GraphStore, type GraphEdge, type GraphNode } from "./store";

const fileNode = (path: string): GraphNode => ({
  id: path.replace(/\W+/g, "_"), label: path, file_type: "code", source_file: path, kind: "file",
});
const fn = (id: string, path: string, label: string): GraphNode => ({
  id, label, file_type: "code", source_file: path, kind: "function", source_location: "L1",
});
const edge = (source: string, target: string, relation: string, source_file: string): GraphEdge => ({
  source, target, relation, confidence: "EXTRACTED", confidence_score: 1, source_file,
});

test("replaceFile swaps nodes/edges for a path and removeFile prunes them", () => {
  const s = new GraphStore();
  s.replaceFile("a.ts", [fileNode("a.ts"), fn("a_foo", "a.ts", "foo")], [
    edge("a.ts".replace(/\W+/g, "_"), "a_foo", "contains", "a.ts"),
  ]);
  expect(s.nodeCount).toBe(2);
  s.replaceFile("a.ts", [fileNode("a.ts"), fn("a_bar", "a.ts", "bar")], []);
  expect(s.getNode("a_foo")).toBeUndefined();
  expect(s.getNode("a_bar")?.label).toBe("bar");
  s.removeFile("a.ts");
  expect(s.nodeCount).toBe(0);
});

test("toJSON/loadJSON round-trip preserves nodes and edges", () => {
  const s = new GraphStore();
  s.replaceFile("a.ts", [fn("a_foo", "a.ts", "foo")], [edge("a_foo", "a_foo", "calls", "a.ts")]);
  const s2 = new GraphStore();
  s2.loadJSON(s.toJSON());
  expect(s2.nodeCount).toBe(1);
  expect(s2.edges()).toHaveLength(1);
});
```

- [ ] **Step 2: Implement `store.ts`**

```typescript
export interface GraphNode {
  id: string;
  label: string;
  file_type: string;
  source_file: string;
  source_location?: string;
  kind?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  confidence_score: number;
  source_file: string;
}

export interface GraphDocument {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, unknown>;
  nodes: GraphNode[];
  links: GraphEdge[];
}

export class GraphStore {
  #nodes = new Map<string, GraphNode>();
  #edges: GraphEdge[] = [];

  get nodeCount() { return this.#nodes.size; }
  get edgeCount() { return this.#edges.length; }

  clear(): void {
    this.#nodes.clear();
    this.#edges = [];
  }

  getNode(id: string): GraphNode | undefined {
    return this.#nodes.get(id);
  }

  nodes(): GraphNode[] {
    return [...this.#nodes.values()];
  }

  edges(): GraphEdge[] {
    return [...this.#edges];
  }

  removeFile(path: string): void {
    for (const [id, n] of this.#nodes) {
      if (n.source_file === path) this.#nodes.delete(id);
    }
    this.#edges = this.#edges.filter((e) => e.source_file !== path);
  }

  replaceFile(path: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    this.removeFile(path);
    for (const n of nodes) this.#nodes.set(n.id, n);
    this.#edges.push(...edges);
  }

  neighbors(id: string, depth = 1): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const seen = new Set<string>([id]);
    let frontier = new Set<string>([id]);
    const outEdges: GraphEdge[] = [];
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>();
      for (const e of this.#edges) {
        if (frontier.has(e.source) || frontier.has(e.target)) {
          outEdges.push(e);
          if (!seen.has(e.source)) { seen.add(e.source); next.add(e.source); }
          if (!seen.has(e.target)) { seen.add(e.target); next.add(e.target); }
        }
      }
      frontier = next;
    }
    const nodes = [...seen].map((i) => this.#nodes.get(i)).filter(Boolean) as GraphNode[];
    return { nodes, edges: outEdges };
  }

  toJSON(): GraphDocument {
    return {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: this.nodes(),
      links: this.edges(),
    };
  }

  loadJSON(doc: GraphDocument): void {
    this.clear();
    for (const n of doc.nodes ?? []) this.#nodes.set(n.id, n);
    this.#edges = [...(doc.links ?? [])];
  }
}
```

- [ ] **Step 3: Write and implement query**

Create `packages/daemon/src/plugins/graphify/query.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { GraphStore } from "./store";
import { queryGraph } from "./query";

test("queryGraph finds symbol and returns neighbors text", () => {
  const s = new GraphStore();
  s.replaceFile("a.ts", [
    { id: "a_ts", label: "a.ts", file_type: "code", source_file: "a.ts", kind: "file" },
    { id: "a_greet", label: "greet", file_type: "code", source_file: "a.ts", kind: "function" },
    { id: "a_helper", label: "helper", file_type: "code", source_file: "a.ts", kind: "function" },
  ], [
    { source: "a_greet", target: "a_helper", relation: "calls", confidence: "EXTRACTED", confidence_score: 1, source_file: "a.ts" },
  ]);
  const r = queryGraph(s, { q: "greet", mode: "neighbors" });
  expect(r.nodes.some((n) => n.id === "a_greet")).toBe(true);
  expect(r.nodes.some((n) => n.id === "a_helper")).toBe(true);
  expect(r.text.toLowerCase()).toContain("greet");
});
```

Create `packages/daemon/src/plugins/graphify/query.ts`:

```typescript
import type { GraphQueryParams, GraphQueryResult } from "@zero/protocol";
import type { GraphStore } from "./store";
import { estimateTokensLocal } from "./tokens";

export function queryGraph(store: GraphStore, params: GraphQueryParams): GraphQueryResult {
  const q = params.q.trim().toLowerCase();
  const mode = params.mode ?? "neighbors";
  const budget = params.budgetTokens ?? 800;

  if (mode === "path") {
    const nodes = store.nodes().filter((n) => n.source_file.toLowerCase().includes(q));
    const text = nodes.map((n) => `${n.kind ?? "node"} ${n.label} @ ${n.source_file}`).join("\n");
    return { nodes: nodes.map(publicNode), edges: [], text: trimBudget(text, budget) };
  }

  const matches = store.nodes().filter((n) =>
    n.label.toLowerCase() === q || n.label.toLowerCase().includes(q) || n.id.includes(q.replace(/\W+/g, "_")));
  if (matches.length === 0) {
    return { nodes: [], edges: [], text: `No graph match for ${params.q}` };
  }

  if (mode === "symbol") {
    const text = matches.map((n) => `${n.kind ?? "symbol"} ${n.label} @ ${n.source_file}${n.source_location ? ":" + n.source_location : ""}`).join("\n");
    return { nodes: matches.map(publicNode), edges: [], text: trimBudget(text, budget) };
  }

  // neighbors of best match (exact label first)
  matches.sort((a, b) => scoreMatch(b, q) - scoreMatch(a, q));
  const best = matches[0]!;
  const { nodes, edges } = store.neighbors(best.id, 1);
  const lines = [
    `Symbol ${best.label} (${best.kind ?? "node"}) @ ${best.source_file}`,
    ...edges.map((e) => `${e.source} -[${e.relation}]-> ${e.target}`),
  ];
  return {
    nodes: nodes.map(publicNode),
    edges: edges.map((e) => ({ source: e.source, target: e.target, relation: e.relation })),
    text: trimBudget(lines.join("\n"), budget),
  };
}

function publicNode(n: { id: string; label: string; source_file?: string; kind?: string }) {
  return { id: n.id, label: n.label, source_file: n.source_file, kind: n.kind };
}

function scoreMatch(n: { label: string; id: string }, q: string): number {
  const l = n.label.toLowerCase();
  if (l === q) return 3;
  if (l.startsWith(q)) return 2;
  if (l.includes(q)) return 1;
  return 0;
}

function trimBudget(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// local mirror so daemon does not import @zero/core
export function estimateTokensLocal(t: string) { return Math.ceil(t.length / 4); }
```

Note: put `estimateTokensLocal` in `query.ts` only if used; otherwise inline `Math.ceil` and drop the unused import/export. Prefer **no** separate tokens file unless shared — keep `Math.ceil(t.length / 4)` inline in `query.ts` and `contextAt.ts` and delete `estimateTokensLocal` if unused.

- [ ] **Step 4: Write and implement contextAt**

Create `packages/daemon/src/plugins/graphify/contextAt.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { GraphStore } from "./store";
import { contextAt } from "./contextAt";

test("contextAt returns enclosing symbol and callees with scores", () => {
  const s = new GraphStore();
  s.replaceFile("src/a.ts", [
    { id: "src_a_ts", label: "a.ts", file_type: "code", source_file: "src/a.ts", kind: "file" },
    { id: "src_a_greet", label: "greet", file_type: "code", source_file: "src/a.ts", kind: "function", source_location: "L2" },
    { id: "src_a_helper", label: "helper", file_type: "code", source_file: "src/a.ts", kind: "function", source_location: "L6" },
  ], [
    { source: "src_a_greet", target: "src_a_helper", relation: "calls", confidence: "EXTRACTED", confidence_score: 1, source_file: "src/a.ts" },
  ]);
  const chunks = contextAt(s, { path: "src/a.ts", position: { line: 1, character: 0 }, maxChunks: 6 });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.some((c) => c.text.includes("greet"))).toBe(true);
  expect(chunks[0]!.score).toBeGreaterThanOrEqual(0.5);
});
```

Create `packages/daemon/src/plugins/graphify/contextAt.ts`:

```typescript
import type { GraphContextAtParams, GraphContextChunk } from "@zero/protocol";
import type { GraphStore, GraphNode } from "./store";

export function contextAt(store: GraphStore, params: GraphContextAtParams): GraphContextChunk[] {
  const max = params.maxChunks ?? 6;
  const line1 = params.position.line + 1; // source_location uses 1-based L{n}
  const inFile = store.nodes().filter((n) => n.source_file === params.path && n.kind && n.kind !== "file");
  if (inFile.length === 0) {
    const fileNodes = store.nodes().filter((n) => n.source_file === params.path);
    return fileNodes.slice(0, max).map((n) => ({
      text: `file ${n.label}`,
      score: 0.4,
      source: `graph:${n.id}`,
    }));
  }

  const enclosing = pickEnclosing(inFile, line1) ?? inFile[0]!;
  const chunks: GraphContextChunk[] = [{
    text: formatSymbol(enclosing),
    score: 0.95,
    source: `graph:${enclosing.id}`,
  }];

  const { edges, nodes } = store.neighbors(enclosing.id, 1);
  for (const e of edges) {
    if (e.relation === "calls" || e.relation === "imports") {
      const otherId = e.source === enclosing.id ? e.target : e.source;
      const other = store.getNode(otherId);
      if (!other) continue;
      chunks.push({
        text: `${e.relation} ${other.label}${other.source_file ? " @ " + other.source_file : ""}`,
        score: e.relation === "imports" ? 0.8 : 0.65,
        source: `graph:${other.id}`,
      });
    }
  }

  for (const n of inFile) {
    if (n.id === enclosing.id) continue;
    if (chunks.length >= max) break;
    chunks.push({ text: formatSymbol(n), score: 0.45, source: `graph:${n.id}` });
  }

  // silence unused
  void nodes;
  return chunks
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

function formatSymbol(n: GraphNode): string {
  return `${n.kind ?? "symbol"} ${n.label} @ ${n.source_file}${n.source_location ? ":" + n.source_location : ""}`;
}

function pickEnclosing(nodes: GraphNode[], line1: number): GraphNode | undefined {
  const withLine = nodes
    .map((n) => ({ n, line: parseLoc(n.source_location) }))
    .filter((x) => x.line !== undefined && x.line! <= line1) as { n: GraphNode; line: number }[];
  withLine.sort((a, b) => b.line - a.line);
  return withLine[0]?.n;
}

function parseLoc(loc?: string): number | undefined {
  if (!loc) return undefined;
  const m = /^L(\d+)/.exec(loc);
  return m ? Number(m[1]) : undefined;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/daemon/src/plugins/graphify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/plugins/graphify/
git commit -m "feat(daemon): add graph store, query, and contextAt"
```

---

### Task 4: Tree-sitter extraction + grammar registry (TS/JS)

**Files:**
- Create: `packages/daemon/src/plugins/graphify/grammars.ts`
- Create: `packages/daemon/src/plugins/graphify/extract.ts`
- Create: `packages/daemon/src/plugins/graphify/extract.test.ts`
- Modify: `packages/daemon/package.json` — add dependencies

**Interfaces:**
- Produces:
  - `DEFAULT_GRAMMARS: Record<languageId, { extensions: string[]; wasm: string }>`
  - `resolveLanguage(path: string, overrides?: GraphifyGrammarSettings): string | undefined`
  - `loadParser(languageId: string): Promise<Parser | null>`
  - `extractFromSource(path: string, source: string, languageId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>`
  - Settings type: `GraphifyGrammarSettings = Record<string, { extensions: string[]; module?: string; wasmPath?: string }>`

**Dependency install (Step 0 of this task):**

```bash
cd packages/daemon
bun add web-tree-sitter
bun add -d tree-sitter-typescript tree-sitter-javascript
```

Copy or reference WASM files. Preferred approach that works under Bun tests:

1. Depend on `web-tree-sitter`.
2. At runtime, resolve WASM paths via `import.meta.find` / `fileURLToPath` from package locations:

```typescript
// grammars.ts resolves something like:
// join(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/tree-sitter-typescript/typescript/tree-sitter-typescript.wasm")
```

If package layout differs, add a small `scripts/copy-grammars.ts` that copies wasm into `packages/daemon/wasm/` and commit those binaries **or** document generate-on-install. Prefer **resolving from node_modules** without committing binaries if the packages ship `.wasm` files.

Verify after install:

```bash
find node_modules/tree-sitter-typescript -name "*.wasm" | head
find node_modules/web-tree-sitter -name "*.wasm" | head
```

- [ ] **Step 1: Write extract test with real parser (integration-style unit test)**

Create fixture source inline in `extract.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { extractFromSource } from "./extract";

const SRC = `
import { helper } from "./util";

export function greet(name: string) {
  return helper(name);
}
`;

test("extractFromSource finds function, import, and call edges for TypeScript", async () => {
  const { nodes, edges } = await extractFromSource("src/a.ts", SRC, "typescript");
  expect(nodes.some((n) => n.label === "greet" && n.kind === "function")).toBe(true);
  expect(edges.some((e) => e.relation === "imports")).toBe(true);
  // call edge may be best-effort; require at least contains + imports
  expect(edges.some((e) => e.relation === "contains")).toBe(true);
}, 30_000);
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test packages/daemon/src/plugins/graphify/extract.test.ts`
Expected: FAIL — not implemented / no grammars.

- [ ] **Step 3: Implement grammars + extract**

`grammars.ts` sketch:

```typescript
import Parser from "web-tree-sitter";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let initPromise: Promise<void> | null = null;

export type GrammarOverride = { extensions: string[]; wasmPath?: string; module?: string };
export type GrammarSettings = Record<string, GrammarOverride>;

const DEFAULT_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

export function resolveLanguage(path: string, overrides?: GrammarSettings): string | undefined {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";
  if (overrides) {
    for (const [lang, cfg] of Object.entries(overrides)) {
      if (cfg.extensions.map((e) => e.toLowerCase()).includes(ext)) return lang;
    }
  }
  return DEFAULT_EXT[ext];
}

export async function ensureParserInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;
}

export async function loadLanguage(languageId: string, overrides?: GrammarSettings): Promise<Parser.Language | null> {
  await ensureParserInit();
  const wasm = resolveWasmPath(languageId, overrides);
  if (!wasm) return null;
  try {
    return await Parser.Language.load(wasm);
  } catch {
    return null;
  }
}

function resolveWasmPath(languageId: string, overrides?: GrammarSettings): string | null {
  const o = overrides?.[languageId];
  if (o?.wasmPath) return o.wasmPath;
  // Map languageId → package wasm. Adjust paths after verifying package layout.
  try {
    if (languageId === "typescript" || languageId === "tsx") {
      const pkg = dirname(require.resolve("tree-sitter-typescript/package.json"));
      return join(pkg, languageId === "tsx" ? "tsx" : "typescript", `tree-sitter-${languageId === "tsx" ? "tsx" : "typescript"}.wasm`);
    }
    if (languageId === "javascript") {
      const pkg = dirname(require.resolve("tree-sitter-javascript/package.json"));
      return join(pkg, "tree-sitter-javascript.wasm");
    }
  } catch {
    return null;
  }
  return null;
}

export function activeLanguages(overrides?: GrammarSettings): string[] {
  const base = ["typescript", "tsx", "javascript"];
  if (!overrides) return base;
  return [...new Set([...base, ...Object.keys(overrides)])];
}
```

`extract.ts` sketch (queries may need tuning against actual grammar node types — run a one-off dump of `tree.rootNode.toString()` if tests fail):

```typescript
import Parser from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "./store";
import { loadLanguage } from "./grammars";

export function nodeId(path: string, entity: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const file = parts.pop() ?? path;
  const parent = parts.pop() ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  const base = [parent, stem].filter(Boolean).join("_");
  return `${base}_${entity}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_");
}

export async function extractFromSource(
  path: string,
  source: string,
  languageId: string,
  overrides?: import("./grammars").GrammarSettings,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const lang = await loadLanguage(languageId, overrides);
  if (!lang) return { nodes: [], edges: [] };

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const fileId = nodeId(path, "file");
  nodes.push({
    id: fileId, label: path.split("/").pop() ?? path, file_type: "code",
    source_file: path, kind: "file",
  });

  const functionTypes = new Set([
    "function_declaration", "generator_function_declaration",
    "method_definition", "function_expression", "arrow_function",
  ]);
  const classTypes = new Set(["class_declaration", "class"]);
  const symbols = new Map<string, string>(); // name -> id

  const walk = (node: Parser.SyntaxNode) => {
    if (functionTypes.has(node.type) || classTypes.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      const name = nameNode?.text ?? (node.type === "arrow_function" ? undefined : undefined);
      if (name) {
        const kind = classTypes.has(node.type) ? "class" : node.type === "method_definition" ? "method" : "function";
        const id = nodeId(path, name);
        const loc = `L${node.startPosition.row + 1}`;
        nodes.push({ id, label: name, file_type: "code", source_file: path, source_location: loc, kind });
        edges.push({
          source: fileId, target: id, relation: "contains",
          confidence: "EXTRACTED", confidence_score: 1, source_file: path,
        });
        symbols.set(name, id);
      }
    }
    if (node.type === "import_statement" || node.type === "import_clause") {
      // handled below via source scan of import_statement only
    }
    for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);

  // imports
  const importQuery = source.matchAll(/import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g);
  for (const m of importQuery) {
    const spec = m[1]!;
    const modId = nodeId(path, `mod_${spec}`);
    if (!nodes.some((n) => n.id === modId)) {
      nodes.push({
        id: modId, label: spec, file_type: "code", source_file: path, kind: "module",
      });
    }
    edges.push({
      source: fileId, target: modId, relation: "imports",
      confidence: "EXTRACTED", confidence_score: 1, source_file: path,
    });
  }

  // naive call edges: identifier() where identifier is a known local symbol
  for (const [name, sid] of symbols) {
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    // skip the declaration line roughly by counting — best-effort
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      // find a caller: nearest previous function in symbols by offset — skip for v1 self
      for (const [callerName, callerId] of symbols) {
        if (callerId === sid) continue;
        // if call site is after caller declaration text position
        const callerPos = source.indexOf(callerName);
        if (callerPos >= 0 && match.index > callerPos) {
          edges.push({
            source: callerId, target: sid, relation: "calls",
            confidence: "EXTRACTED", confidence_score: 1, source_file: path,
          });
          break;
        }
      }
    }
  }

  parser.delete();
  return { nodes, edges };
}
```

**Important:** If `web-tree-sitter` default import fails under Bun, use:

```typescript
import Parser from "web-tree-sitter";
// or: const Parser = (await import("web-tree-sitter")).default;
```

Tune until `extract.test.ts` passes. Prefer tree-sitter Query API if the regex call heuristic is too noisy — but tests only require function + import + contains.

- [ ] **Step 4: Run extract tests**

Run: `bun test packages/daemon/src/plugins/graphify/extract.test.ts`
Expected: PASS within 30s.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/package.json packages/daemon/src/plugins/graphify/grammars.ts packages/daemon/src/plugins/graphify/extract.ts packages/daemon/src/plugins/graphify/extract.test.ts bun.lock
git commit -m "feat(daemon): tree-sitter extract for TS/JS graph nodes"
```

---

### Task 5: Indexer + Graphify plugin + main wiring

**Files:**
- Create: `packages/daemon/src/plugins/graphify/indexer.ts`
- Create: `packages/daemon/src/plugins/graphify/indexer.test.ts`
- Create: `packages/daemon/src/plugins/graphify/index.ts`
- Create: `packages/daemon/src/plugins/graphify/fixtures/mini-repo/src/util.ts`
- Create: `packages/daemon/src/plugins/graphify/fixtures/mini-repo/src/app.ts`
- Create: `packages/daemon/src/plugins/graphify/eval.test.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/src/main.test.ts`

**Interfaces:**
- Produces:
  - `class GraphIndexer` with `constructor({ workspace, store, getGrammarSettings })`, `startFullIndex(): void`, `onFileChanged(path: string): void`, `status(): GraphStatusResult`, `waitUntilReady(timeoutMs?): Promise<void>` (test helper)
  - `createGraphifyPlugin: (ctx: PluginContext) => ZeroPlugin` — actually factory `(ctx) => plugin` matching host API; activate starts indexer and registers RPCs
  - `startZero` activates host with Graphify

**Fixture files:**

`fixtures/mini-repo/src/util.ts`:
```typescript
export function helper(name: string): string {
  return name.toUpperCase();
}
```

`fixtures/mini-repo/src/app.ts`:
```typescript
import { helper } from "./util";

export function greet(name: string): string {
  return helper(name);
}
```

- [ ] **Step 1: Write indexer + eval tests**

```typescript
// indexer.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../workspace";
import { GraphStore } from "./store";
import { GraphIndexer } from "./indexer";

test("full index populates store for ts files", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-idx-"));
  writeFileSync(join(root, "a.ts"), "export function foo() { return 1; }\n");
  const workspace = new Workspace(root);
  const store = new GraphStore();
  const indexer = new GraphIndexer({ workspace, store, getGrammarSettings: async () => undefined });
  await indexer.runFullIndex();
  expect(store.nodeCount).toBeGreaterThan(0);
  expect(indexer.status().ready).toBe(true);
  expect(indexer.status().languages.length).toBeGreaterThan(0);
}, 60_000);
```

```typescript
// eval.test.ts — fixture context quality
import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Workspace } from "../../workspace";
import { GraphStore } from "./store";
import { GraphIndexer } from "./indexer";
import { contextAt } from "./contextAt";
import { queryGraph } from "./query";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mini-repo");

test("eval: contextAt near greet mentions helper or greet", async () => {
  const workspace = new Workspace(fixtureRoot);
  const store = new GraphStore();
  const indexer = new GraphIndexer({ workspace, store, getGrammarSettings: async () => undefined });
  await indexer.runFullIndex();
  const chunks = contextAt(store, {
    path: "src/app.ts",
    position: { line: 3, character: 0 },
    maxChunks: 6,
  });
  const blob = chunks.map((c) => c.text).join("\n").toLowerCase();
  expect(blob.includes("greet") || blob.includes("helper")).toBe(true);
}, 60_000);

test("eval: queryGraph greet returns a node", async () => {
  const workspace = new Workspace(fixtureRoot);
  const store = new GraphStore();
  const indexer = new GraphIndexer({ workspace, store, getGrammarSettings: async () => undefined });
  await indexer.runFullIndex();
  const r = queryGraph(store, { q: "greet" });
  expect(r.nodes.length).toBeGreaterThan(0);
}, 60_000);
```

- [ ] **Step 2: Implement indexer**

```typescript
// indexer.ts — key methods
export class GraphIndexer {
  #workspace: Workspace;
  #store: GraphStore;
  #getGrammarSettings: () => Promise<GrammarSettings | undefined>;
  #indexing = false;
  #ready = false;
  #fileCount = 0;
  #lastError?: string;
  #debounce = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: {
    workspace: Workspace;
    store: GraphStore;
    getGrammarSettings: () => Promise<GrammarSettings | undefined>;
  }) { /* assign */ }

  status(): GraphStatusResult {
    return {
      ready: this.#ready,
      indexing: this.#indexing,
      fileCount: this.#fileCount,
      nodeCount: this.#store.nodeCount,
      edgeCount: this.#store.edgeCount,
      lastError: this.#lastError,
      languages: activeLanguages(/* overrides */),
    };
  }

  startFullIndex(): void {
    void this.runFullIndex();
  }

  async runFullIndex(): Promise<void> {
    this.#indexing = true;
    this.#ready = false;
    try {
      const overrides = await this.#getGrammarSettings();
      const entries = await this.#workspace.tree();
      const files = entries.filter((e) => e.kind === "file" && resolveLanguage(e.path, overrides));
      this.#store.clear();
      this.#fileCount = 0;
      for (const f of files) {
        await this.#indexPath(f.path, overrides);
        this.#fileCount++;
      }
      this.#ready = true;
    } catch (e) {
      this.#lastError = e instanceof Error ? e.message : String(e);
      this.#ready = this.#store.nodeCount > 0;
    } finally {
      this.#indexing = false;
    }
  }

  onFileChanged(path: string): void {
    const prev = this.#debounce.get(path);
    if (prev) clearTimeout(prev);
    this.#debounce.set(path, setTimeout(() => {
      this.#debounce.delete(path);
      void this.#reindexPath(path);
    }, 150));
  }

  async #reindexPath(path: string): Promise<void> {
    const overrides = await this.#getGrammarSettings();
    if (!resolveLanguage(path, overrides)) {
      this.#store.removeFile(path);
      return;
    }
    try {
      await this.#indexPath(path, overrides);
    } catch (e) {
      this.#lastError = `${path}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async #indexPath(path: string, overrides?: GrammarSettings): Promise<void> {
    const lang = resolveLanguage(path, overrides);
    if (!lang) return;
    let source: string;
    try {
      source = await this.#workspace.read(path);
    } catch {
      this.#store.removeFile(path);
      return;
    }
    const { nodes, edges } = await extractFromSource(path, source, lang, overrides);
    this.#store.replaceFile(path, nodes, edges);
  }
}
```

- [ ] **Step 3: Implement `createGraphifyPlugin`**

```typescript
// index.ts
import { z } from "zod";
import type { PluginContext, ZeroPlugin } from "../types";
import { GraphStore } from "./store";
import { GraphIndexer } from "./indexer";
import { queryGraph } from "./query";
import { contextAt } from "./contextAt";
import type { GrammarSettings } from "./grammars";

export function createGraphifyPlugin(ctx: PluginContext): ZeroPlugin {
  const store = new GraphStore();
  let indexer: GraphIndexer;

  const getGrammarSettings = async (): Promise<GrammarSettings | undefined> => {
    const value = await ctx.workspace.readSetting("graphify.grammars");
    if (typeof value !== "object" || value === null) return undefined;
    return value as GrammarSettings;
  };

  indexer = new GraphIndexer({ workspace: ctx.workspace, store, getGrammarSettings });

  return {
    manifest: {
      id: "graphify",
      name: "Graphify",
      version: "0.1.0",
      contributions: {
        rpcMethods: ["graph/contextAt", "graph/query", "graph/status"],
        contextProviders: ["graph"],
        tools: ["graph_query"],
      },
    },
    async activate(c) {
      c.register("graph/status", z.object({}).optional().transform(() => ({})),
        async () => indexer.status());
      c.register(
        "graph/contextAt",
        z.object({
          path: z.string(),
          position: z.object({ line: z.number(), character: z.number() }),
          maxChunks: z.number().optional(),
        }),
        async (p) => {
          const st = indexer.status();
          const chunks = st.nodeCount > 0 ? contextAt(store, p) : [];
          return { chunks, ready: st.ready || st.nodeCount > 0 };
        },
      );
      c.register(
        "graph/query",
        z.object({
          q: z.string(),
          mode: z.enum(["neighbors", "symbol", "path"]).optional(),
          budgetTokens: z.number().optional(),
        }),
        async (p) => queryGraph(store, p),
      );
      indexer.startFullIndex();
    },
    health() {
      const s = indexer.status();
      return { ok: !s.lastError || s.ready, detail: s.lastError };
    },
  };
}

/** Used by main to hook fs/changed — expose indexer via weak map or return handle. */
export type GraphifyHandles = { indexer: GraphIndexer; store: GraphStore };
```

**Problem:** `main` needs `onFileChanged` on the indexer. Cleaner approach:

```typescript
export function createGraphifyPlugin(): {
  factory: (ctx: PluginContext) => ZeroPlugin;
  getIndexer: () => GraphIndexer | undefined;
} {
  let indexer: GraphIndexer | undefined;
  const factory = (ctx: PluginContext): ZeroPlugin => {
    // create indexer, assign to outer `indexer`
    ...
  };
  return { factory, getIndexer: () => indexer };
}
```

Or store indexer on a module-level variable set during activate. Prefer the factory holder returned to `main.ts`.

- [ ] **Step 4: Wire `main.ts`**

```typescript
import { PluginHost } from "./plugins/host";
import { createGraphify } from "./plugins/graphify"; // exports createGraphify() holder

export function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);
  // ... existing fs/settings registers ...

  const graphify = createGraphify();
  const host = new PluginHost({
    rpc: daemon.rpc,
    workspace: ws,
    root: opts.root,
    broadcast: (m, p) => daemon.broadcast(m, p),
  });
  host.registerHostRpcs();
  // activate is async — fire and forget but tests can await a returned promise
  const pluginsReady = host.activateBuiltins([graphify.factory]);

  const unwatch = ws.watch((path) => {
    daemon.broadcast("fs/changed", { path });
    graphify.getIndexer()?.onFileChanged(path);
  });

  const stop = daemon.stop;
  return {
    ...daemon,
    pluginsReady,
    stop: () => { unwatch(); stop(); },
  };
}
```

- [ ] **Step 5: Integration test in `main.test.ts`**

```typescript
test("plugin/list and graph/status over the wire", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "export function foo() { return 1; }\n");
  const d = startZero({ root });
  await d.pluginsReady;
  // wait until ready or timeout
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  const list = await client.request<{ plugins: { id: string }[] }>("plugin/list");
  expect(list.plugins.some((p) => p.id === "graphify")).toBe(true);

  const deadline = Date.now() + 30_000;
  let status = await client.request<{ ready: boolean; nodeCount: number }>("graph/status");
  while (!status.ready && Date.now() < deadline) {
    await Bun.sleep(100);
    status = await client.request("graph/status");
  }
  expect(status.nodeCount).toBeGreaterThan(0);

  const ctx = await client.request<{ chunks: unknown[]; ready: boolean }>("graph/contextAt", {
    path: "a.ts", position: { line: 0, character: 0 },
  });
  expect(ctx.ready).toBe(true);

  ws.close(); d.stop();
}, 60_000);
```

Extend `startZero` return type so `pluginsReady` exists.

- [ ] **Step 6: Run daemon tests**

Run: `bun test packages/daemon`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/plugins/graphify packages/daemon/src/main.ts packages/daemon/src/main.test.ts
git commit -m "feat(daemon): Graphify plugin, indexer, and graph RPC wiring"
```

---

### Task 6: Persist graph to `.zero/graph.json`

**Files:**
- Modify: `packages/daemon/src/plugins/graphify/indexer.ts`
- Modify: `packages/daemon/src/plugins/graphify/indexer.test.ts`

**Interfaces:**
- After successful full index, write JSON via `workspace.write(".zero/graph.json", JSON.stringify(store.toJSON()))` — but `Workspace.write` must allow `.zero/` (settings already use it; confirm write path works).
- On startup, before or after scheduling full index: try `read` `.zero/graph.json`, `loadJSON`, set `ready=true` with partial, still refresh in background.

- [ ] **Step 1: Test warm cache**

```typescript
test("loads cache then reindexes", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-idx-"));
  writeFileSync(join(root, "a.ts"), "export function foo() {}\n");
  mkdirSync(join(root, ".zero"), { recursive: true });
  const store = new GraphStore();
  store.replaceFile("a.ts", [{
    id: "a_foo", label: "foo", file_type: "code", source_file: "a.ts", kind: "function",
  }], []);
  writeFileSync(join(root, ".zero/graph.json"), JSON.stringify(store.toJSON()));

  const workspace = new Workspace(root);
  const store2 = new GraphStore();
  const indexer = new GraphIndexer({
    workspace, store: store2, getGrammarSettings: async () => undefined,
  });
  await indexer.loadCacheIfPresent();
  expect(store2.getNode("a_foo")).toBeDefined();
});
```

- [ ] **Step 2: Implement `loadCacheIfPresent` + `saveCache` on indexer; call from `runFullIndex` end and from plugin activate before `startFullIndex`**

- [ ] **Step 3: Run tests + commit**

```bash
git add packages/daemon/src/plugins/graphify/indexer.ts packages/daemon/src/plugins/graphify/indexer.test.ts
git commit -m "feat(daemon): warm Graphify cache from .zero/graph.json"
```

---

### Task 7: Core — `GraphContext`

**Files:**
- Create: `packages/core/src/graphContext.ts`
- Create: `packages/core/src/graphContext.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `GraphContextClient`, `GraphContext` with `name = "graph"`, `gather(req)` → `graph/contextAt`

- [ ] **Step 1: Failing test**

```typescript
import { expect, test } from "bun:test";
import { GraphContext, type GraphContextClient } from "./graphContext";

test("gather maps graph/contextAt chunks and derives cursor from prefix", async () => {
  let sent: unknown;
  const client: GraphContextClient = {
    request: async (method, params) => {
      sent = { method, params };
      return { ready: true, chunks: [{ text: "function greet", score: 0.9, source: "graph:g" }] };
    },
  };
  const ctx = new GraphContext(client);
  const chunks = await ctx.gather({ path: "a.ts", prefix: "line\ngre", suffix: "et" });
  expect(sent).toEqual({
    method: "graph/contextAt",
    params: { path: "a.ts", position: { line: 1, character: 3 }, maxChunks: 6 },
  });
  expect(chunks[0]).toEqual({
    source: "graph:g", text: "function greet", score: 0.9, tokenCost: Math.ceil("function greet".length / 4),
  });
});

test("gather returns [] when not ready", async () => {
  const client: GraphContextClient = {
    request: async () => ({ ready: false, chunks: [{ text: "x", score: 1 }] }),
  };
  const ctx = new GraphContext(client);
  expect(await ctx.gather({ path: "a.ts", prefix: "", suffix: "" })).toEqual([]);
});

test("gather returns [] on request error", async () => {
  const client: GraphContextClient = {
    request: async () => { throw new Error("down"); },
  };
  const ctx = new GraphContext(client);
  expect(await ctx.gather({ path: "a.ts", prefix: "", suffix: "" })).toEqual([]);
});
```

- [ ] **Step 2: Implement**

```typescript
import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";
import { estimateTokens } from "./tokens";

export interface GraphContextClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

function cursorPosition(prefix: string): { line: number; character: number } {
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

export class GraphContext implements ContextProvider {
  name = "graph";
  constructor(private client: GraphContextClient) {}

  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    try {
      const result = await this.client.request<{
        chunks: { text: string; score: number; source?: string }[];
        ready: boolean;
      }>("graph/contextAt", {
        path: req.path,
        position: cursorPosition(req.prefix),
        maxChunks: 6,
      });
      if (!result.ready) return [];
      return result.chunks.map((c) => ({
        source: c.source ?? "graph",
        text: c.text,
        score: c.score,
        tokenCost: estimateTokens(c.text),
      }));
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 3: Export from `index.ts`**

```typescript
export { GraphContext, type GraphContextClient } from "./graphContext";
```

- [ ] **Step 4: Test + commit**

```bash
bun test packages/core
bunx tsc -b
git add packages/core/src/graphContext.ts packages/core/src/graphContext.test.ts packages/core/src/index.ts
git commit -m "feat(core): add GraphContext provider"
```

---

### Task 8: Web — wire GraphContext, status bar, settings note

**Files:**
- Modify: `packages/web/src/completionSetup.ts`
- Modify: `packages/web/src/workbench/StatusBar.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx` (or wherever completion + StatusBar are composed)
- Optional: `packages/web/src/workbench/settings/SettingsPanel.tsx` — short note + link that `graphify.grammars` is set via `settings/set` / `.zero/settings.json` (full form optional; minimum is documenting in Settings panel as read-only help text)

**Interfaces:**
- `createCompletion` gains optional `client: { request }` and includes `new GraphContext(client)` in `context` array.
- StatusBar shows `graphStatus: { ready, indexing, lastError? } | null`.

- [ ] **Step 1: Find Workbench completion wiring**

```bash
grep -n "createCompletion\|StatusBar\|BufferContext" packages/web/src -r
```

- [ ] **Step 2: Update `completionSetup.ts`**

```typescript
import { CompletionEngine, CompletionScheduler, BufferContext, GraphContext,
  ChromeNanoProvider, OpenAICompatProvider, type NanoApi } from "@zero/core";
// ...
export function createCompletion(
  getView: () => EditorView | undefined,
  path: () => string,
  client?: { request<R>(method: string, params?: unknown): Promise<R> },
) {
  const buffers = new BufferContext();
  const context = client
    ? [buffers, new GraphContext(client)]
    : [buffers];
  const engine = new CompletionEngine({
    providers: [ /* unchanged */ ],
    context,
  });
  // ... rest unchanged, return { engine, buffers, request }
}
```

- [ ] **Step 3: Workbench — pass client into createCompletion; poll graph/status every 2s or on focus**

```typescript
const [graphStatus, setGraphStatus] = useState<{
  ready: boolean; indexing: boolean; lastError?: string; nodeCount?: number;
} | null>(null);

useEffect(() => {
  let cancelled = false;
  const tick = async () => {
    try {
      const s = await client.request<{
        ready: boolean; indexing: boolean; lastError?: string; nodeCount: number;
      }>("graph/status");
      if (!cancelled) setGraphStatus(s);
    } catch {
      if (!cancelled) setGraphStatus({ ready: false, indexing: false, lastError: "unreachable" });
    }
  };
  tick();
  const id = setInterval(tick, 2000);
  return () => { cancelled = true; clearInterval(id); };
}, [client]);
```

- [ ] **Step 4: StatusBar slot**

```tsx
{props.graphStatus && (
  <span title={props.graphStatus.lastError ?? ""}>
    {props.graphStatus.indexing ? "Indexing…" : props.graphStatus.ready ? `Graph ${props.graphStatus.nodeCount ?? ""}` : "Graph off"}
  </span>
)}
```

- [ ] **Step 5: Settings panel help (minimal)**

Add a paragraph under settings:

> Graphify: structural code graph for completions. Default languages: TypeScript, JavaScript. Add others via `.zero/settings.json` key `graphify.grammars` (see docs/plugins.md).

- [ ] **Step 6: Typecheck web package**

Run: `bunx tsc -b && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): wire GraphContext and indexer status"
```

---

### Task 9: Docs alignment + design status

**Files:**
- Modify: `docs/plugins.md` (only if method names or settings keys drifted)
- Modify: `README.md` if status needs “M3 implemented” vs “in progress”
- Modify: `docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md` — set Status to `Approved`

- [ ] **Step 1: Diff docs against shipped APIs; fix mismatches**

- [ ] **Step 2: Commit**

```bash
git add docs README.md
git commit -m "docs: align plugins README with M3 Graphify APIs"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full suite**

```bash
bun test
bun run typecheck
```

Expected: all pass, 0 type errors.

- [ ] **Step 2: Manual smoke (optional but recommended)**

```bash
bun packages/daemon/bin/zero.ts .
# open browser URL printed; confirm status bar shows Graph; type in a .ts file
```

- [ ] **Step 3: If anything failed, fix in place with tests; do not claim complete until green**

---

## Self-review (plan author)

**Spec coverage**

| Spec item | Task |
|---|---|
| Plugin host minimal built-ins | 2, 5 |
| Graphify tree-sitter indexer | 4, 5 |
| Grammar registry TS/JS + settings | 4, 5, 8 |
| Protocol graph/* plugin/* | 1, 5 |
| GraphContext | 7, 8 |
| graph/query for M4 | 3, 5 |
| Fixture eval | 5 (`eval.test.ts`) |
| Persist cache | 6 |
| Docs | 9 (base already landed) |
| Degradation | 7 empty on error; 5 partial ready |

**Placeholders:** none intentional; WASM paths may need adjustment after `find` on installed packages — that is an implementation calibration step inside Task 4, not an open design fork.

**Type consistency:** `GraphContextAtParams` / `GraphQueryParams` / `GraphStatusResult` names match between protocol Task 1 and daemon Task 5 Zod schemas and core Task 7.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-m3-graphify-and-plugin-host.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with executing-plans checkpoints  

Which approach?
