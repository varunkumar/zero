import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });
  await indexer.runFullIndex();
  expect(store.nodeCount).toBeGreaterThan(0);
  expect(indexer.status().ready).toBe(true);
  expect(indexer.status().languages.length).toBeGreaterThan(0);
  expect(existsSync(join(root, ".zero", "graph.json"))).toBe(true);
  const cached = JSON.parse(
    readFileSync(join(root, ".zero", "graph.json"), "utf8"),
  ) as { nodes: unknown[] };
  expect(cached.nodes.length).toBeGreaterThan(0);
}, 60_000);

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
  expect(indexer.status().ready).toBe(true);
});

test("onFileChanged reindexes after debounce", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-idx-"));
  writeFileSync(join(root, "a.ts"), "export function foo() { return 1; }\n");
  const workspace = new Workspace(root);
  const store = new GraphStore();
  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });
  await indexer.runFullIndex();
  const before = store.nodeCount;
  writeFileSync(
    join(root, "a.ts"),
    "export function foo() { return 1; }\nexport function bar() { return 2; }\n",
  );
  indexer.onFileChanged("a.ts");
  await Bun.sleep(300);
  expect(store.nodeCount).toBeGreaterThanOrEqual(before);
  expect(store.nodes().some((n) => n.label === "bar")).toBe(true);
}, 60_000);

test("full reindex keeps warm graph ready and nodes while rebuilding", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-idx-warm-"));
  writeFileSync(join(root, "a.ts"), "export function foo() { return 1; }\n");
  writeFileSync(join(root, "b.ts"), "export function bar() { return 2; }\n");
  const workspace = new Workspace(root);
  const store = new GraphStore();
  const origRead = workspace.read.bind(workspace);

  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });
  await indexer.runFullIndex();
  expect(indexer.status().ready).toBe(true);
  const warmNodes = store.nodeCount;
  expect(warmNodes).toBeGreaterThan(0);

  // Second full index: sample status on first source read mid-rebuild.
  let mid:
    | { ready: boolean; nodeCount: number; indexing: boolean }
    | undefined;
  workspace.read = async (rel: string) => {
    if (rel.endsWith(".ts") && mid === undefined) {
      mid = {
        ready: indexer.status().ready,
        nodeCount: store.nodeCount,
        indexing: indexer.status().indexing,
      };
    }
    return origRead(rel);
  };

  await indexer.runFullIndex();
  expect(mid).toBeDefined();
  expect(mid!.indexing).toBe(true);
  expect(mid!.ready).toBe(true);
  expect(mid!.nodeCount).toBe(warmNodes);
  expect(indexer.status().ready).toBe(true);
  expect(store.nodeCount).toBeGreaterThan(0);
}, 60_000);

test("full-index file extract failure continues other files", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-idx-fail-"));
  writeFileSync(join(root, "ok.ts"), "export function ok() { return 1; }\n");
  writeFileSync(join(root, "bad.ts"), "export function bad() { return 2; }\n");
  const workspace = new Workspace(root);
  const store = new GraphStore();
  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });

  // Simulate per-file index failure (temp store uses GraphStore too).
  const origReplace = GraphStore.prototype.replaceFile;
  GraphStore.prototype.replaceFile = function (
    this: GraphStore,
    path: string,
    nodes: Parameters<GraphStore["replaceFile"]>[1],
    edges: Parameters<GraphStore["replaceFile"]>[2],
  ) {
    if (path === "bad.ts") throw new Error("extract boom");
    return origReplace.call(this, path, nodes, edges);
  };
  try {
    await indexer.runFullIndex();
    expect(store.nodes().some((n) => n.label === "ok")).toBe(true);
    expect(indexer.status().ready).toBe(true);
    expect(indexer.status().lastError).toContain("bad.ts");
    expect(indexer.status().lastError).toContain("extract boom");
  } finally {
    GraphStore.prototype.replaceFile = origReplace;
  }
}, 60_000);

test("onFileChanged during full index is applied after full index settles", async () => {
  // Two files so we can block mid full-index after a.ts is already in the
  // temp store: without queueing, a concurrent reindex of a.ts would land on
  // the live store and then be wiped by the temp swap.
  const root = mkdtempSync(join(tmpdir(), "zero-idx-race-"));
  writeFileSync(join(root, "a.ts"), "export function foo() { return 1; }\n");
  writeFileSync(join(root, "b.ts"), "export function bar() { return 2; }\n");
  const workspace = new Workspace(root);
  const store = new GraphStore();
  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });
  await indexer.runFullIndex();
  expect(store.nodes().some((n) => n.label === "foo")).toBe(true);

  const origRead = workspace.read.bind(workspace);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let blocked = false;
  workspace.read = async (rel: string) => {
    // Block on b.ts so a.ts has already been indexed into the temp store.
    if ((rel === "b.ts" || rel.endsWith("/b.ts")) && !blocked) {
      blocked = true;
      await gate;
    }
    return origRead(rel);
  };

  const full = indexer.runFullIndex();
  for (let i = 0; i < 100 && !blocked; i++) await Bun.sleep(20);
  expect(blocked).toBe(true);

  writeFileSync(
    join(root, "a.ts"),
    "export function foo() { return 1; }\nexport function late() { return 3; }\n",
  );
  indexer.onFileChanged("a.ts");
  // Debounce (150ms) while full index is still gated on b.ts.
  await Bun.sleep(250);
  release();
  await full;
  expect(store.nodes().some((n) => n.label === "late")).toBe(true);
}, 60_000);
