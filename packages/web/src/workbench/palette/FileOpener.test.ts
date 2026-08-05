import { expect, test } from "bun:test";
import { rankPaths } from "./FileOpener";

test("an empty query returns the first N paths unranked", () => {
  const paths = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
  const ranked = rankPaths(paths, "", 200);
  expect(ranked.length).toBe(200);
  expect(ranked[0]).toBe("src/file-0.ts");
});

test("results are capped at the limit even when everything matches", () => {
  const paths = Array.from({ length: 1000 }, (_, i) => `src/widget-${i}.ts`);
  expect(rankPaths(paths, "widget", 200).length).toBe(200);
});

test("non-matching paths are dropped and matches are ranked", () => {
  const ranked = rankPaths(["src/workbench/store.ts", "README.md", "src/store.ts"], "store");
  expect(ranked).toContain("src/store.ts");
  expect(ranked).toContain("src/workbench/store.ts");
  expect(ranked).not.toContain("README.md");
  expect(ranked[0]).toBe("src/store.ts"); // shorter/tighter match ranks first
});
