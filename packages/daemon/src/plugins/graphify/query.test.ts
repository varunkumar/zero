import { expect, test } from "bun:test";
import { GraphStore } from "./store";
import { queryGraph } from "./query";

test("queryGraph finds symbol and returns neighbors text", () => {
  const s = new GraphStore();
  s.replaceFile(
    "a.ts",
    [
      {
        id: "a_ts",
        label: "a.ts",
        file_type: "code",
        source_file: "a.ts",
        kind: "file",
      },
      {
        id: "a_greet",
        label: "greet",
        file_type: "code",
        source_file: "a.ts",
        kind: "function",
      },
      {
        id: "a_helper",
        label: "helper",
        file_type: "code",
        source_file: "a.ts",
        kind: "function",
      },
    ],
    [
      {
        source: "a_greet",
        target: "a_helper",
        relation: "calls",
        confidence: "EXTRACTED",
        confidence_score: 1,
        source_file: "a.ts",
      },
    ],
  );
  const r = queryGraph(s, { q: "greet", mode: "neighbors" });
  expect(r.nodes.some((n) => n.id === "a_greet")).toBe(true);
  expect(r.nodes.some((n) => n.id === "a_helper")).toBe(true);
  expect(r.text.toLowerCase()).toContain("greet");
});
