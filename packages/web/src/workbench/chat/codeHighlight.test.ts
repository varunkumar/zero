import { expect, test } from "bun:test";
import { highlightCodeHtml, highlightDiffHtml } from "./codeHighlight";

test("highlightCodeHtml wraps recognized tokens in zero-tok-* spans and escapes text", () => {
  const html = highlightCodeHtml("const x = 1;", "js");
  expect(html).not.toBeNull();
  expect(html).toContain("zero-tok-keyword");
  expect(html).toContain("const");
});

test("highlightCodeHtml returns null for an unrecognized language", () => {
  expect(highlightCodeHtml("whatever", "brainfuck")).toBeNull();
});

test("highlightCodeHtml escapes HTML-significant characters", () => {
  const html = highlightCodeHtml("const s = \"<script>\";", "js");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("highlightDiffHtml colors +/- lines and escapes content", () => {
  const html = highlightDiffHtml("+added <b>\n-removed\n context");
  expect(html).toContain("zero-diff-add");
  expect(html).toContain("zero-diff-del");
  expect(html).toContain("zero-diff-context");
  expect(html).toContain("&lt;b&gt;");
});
