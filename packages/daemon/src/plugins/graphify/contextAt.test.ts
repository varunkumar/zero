import { expect, test } from "bun:test";
import { GraphStore } from "./store";
import { contextAt } from "./contextAt";

test("contextAt returns enclosing symbol and callees with scores", () => {
  const s = new GraphStore();
  s.replaceFile(
    "src/a.ts",
    [
      {
        id: "src_a_ts",
        label: "a.ts",
        file_type: "code",
        source_file: "src/a.ts",
        kind: "file",
      },
      {
        id: "src_a_greet",
        label: "greet",
        file_type: "code",
        source_file: "src/a.ts",
        kind: "function",
        source_location: "L2",
      },
      {
        id: "src_a_helper",
        label: "helper",
        file_type: "code",
        source_file: "src/a.ts",
        kind: "function",
        source_location: "L6",
      },
    ],
    [
      {
        source: "src_a_greet",
        target: "src_a_helper",
        relation: "calls",
        confidence: "EXTRACTED",
        confidence_score: 1,
        source_file: "src/a.ts",
      },
    ],
  );
  const chunks = contextAt(s, {
    path: "src/a.ts",
    position: { line: 1, character: 0 },
    maxChunks: 6,
  });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.some((c) => c.text.includes("greet"))).toBe(true);
  expect(chunks[0]!.score).toBeGreaterThanOrEqual(0.5);
});
