import { expect, test } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../../workspace";
import { GraphStore } from "./store";
import { GraphIndexer } from "./indexer";
import { contextAt } from "./contextAt";
import { queryGraph } from "./query";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/mini-repo",
);

test("eval: contextAt near greet mentions helper or greet", async () => {
  const workspace = new Workspace(fixtureRoot);
  const store = new GraphStore();
  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });
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
  const indexer = new GraphIndexer({
    workspace,
    store,
    getGrammarSettings: async () => undefined,
  });
  await indexer.runFullIndex();
  const r = queryGraph(store, { q: "greet" });
  expect(r.nodes.length).toBeGreaterThan(0);
}, 60_000);
