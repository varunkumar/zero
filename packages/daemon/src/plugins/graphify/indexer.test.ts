import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
}, 60_000);

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
