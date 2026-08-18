import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview, renderMarkdown } from "./MarkdownPreview";

test("renderMarkdown converts headings and emphasis to HTML", () => {
  const html = renderMarkdown("# Title\n\nSome **bold** text.");
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>bold</strong>");
});

test("MarkdownPreview renders the converted HTML into the DOM", () => {
  const html = renderToStaticMarkup(<MarkdownPreview content="# Hi" />);
  expect(html).toContain("<h1>Hi</h1>");
});
