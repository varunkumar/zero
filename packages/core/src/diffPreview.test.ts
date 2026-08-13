import { expect, test } from "bun:test";
import { diffPreview } from "./diffPreview";

test("identical text produces an all-context diff", () => {
  expect(diffPreview("a\nb", "a\nb")).toBe(" a\n b");
});

test("marks added and removed lines", () => {
  expect(diffPreview("a\nb\nc", "a\nx\nc")).toBe(" a\n-b\n+x\n c");
});

test("pure addition", () => {
  expect(diffPreview("a", "a\nb")).toBe(" a\n+b");
});

test("pure deletion", () => {
  expect(diffPreview("a\nb", "a")).toBe(" a\n-b");
});

test("empty old text (new file)", () => {
  expect(diffPreview("", "hello")).toBe("+hello");
});

test("very large inputs fall back to a summary instead of the O(n*m) diff", () => {
  const big = "line\n".repeat(1000);
  const out = diffPreview(big, big + "extra\n");
  expect(out).toContain("[diff too large to render in full");
});
