import { expect, test } from "bun:test";
import { GraphStore, type GraphEdge, type GraphNode } from "./store";

const fileNode = (path: string): GraphNode => ({
  id: path.replace(/\W+/g, "_"),
  label: path,
  file_type: "code",
  source_file: path,
  kind: "file",
});
const fn = (id: string, path: string, label: string): GraphNode => ({
  id,
  label,
  file_type: "code",
  source_file: path,
  kind: "function",
  source_location: "L1",
});
const edge = (
  source: string,
  target: string,
  relation: string,
  source_file: string,
): GraphEdge => ({
  source,
  target,
  relation,
  confidence: "EXTRACTED",
  confidence_score: 1,
  source_file,
});

test("replaceFile swaps nodes/edges for a path and removeFile prunes them", () => {
  const s = new GraphStore();
  s.replaceFile(
    "a.ts",
    [fileNode("a.ts"), fn("a_foo", "a.ts", "foo")],
    [edge("a.ts".replace(/\W+/g, "_"), "a_foo", "contains", "a.ts")],
  );
  expect(s.nodeCount).toBe(2);
  s.replaceFile("a.ts", [fileNode("a.ts"), fn("a_bar", "a.ts", "bar")], []);
  expect(s.getNode("a_foo")).toBeUndefined();
  expect(s.getNode("a_bar")?.label).toBe("bar");
  s.removeFile("a.ts");
  expect(s.nodeCount).toBe(0);
});

test("toJSON/loadJSON round-trip preserves nodes and edges", () => {
  const s = new GraphStore();
  s.replaceFile(
    "a.ts",
    [fn("a_foo", "a.ts", "foo")],
    [edge("a_foo", "a_foo", "calls", "a.ts")],
  );
  const s2 = new GraphStore();
  s2.loadJSON(s.toJSON());
  expect(s2.nodeCount).toBe(1);
  expect(s2.edges()).toHaveLength(1);
});
