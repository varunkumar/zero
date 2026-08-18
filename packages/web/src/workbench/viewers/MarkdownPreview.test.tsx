import "../../testUtils/domTestSetup";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview, renderMarkdown } from "./MarkdownPreview";

test("renderMarkdown converts headings and emphasis to HTML", () => {
  const html = renderMarkdown("# Title\n\nSome **bold** text.");
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>bold</strong>");
});

test("renderMarkdown preserves normal Markdown constructs: links and code blocks", () => {
  const html = renderMarkdown("[a link](https://example.com)\n\n```js\nconst x = 1;\n```");
  expect(html).toContain('<a href="https://example.com">a link</a>');
  expect(html).toContain("<pre>");
  expect(html).toContain("const x = 1;");
});

test("renderMarkdown strips a script tag payload", () => {
  const html = renderMarkdown("# Title\n\n<script>alert(document.cookie)</script>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("alert(document.cookie)</script>");
});

test("renderMarkdown strips an onerror handler from an inline image payload", () => {
  const html = renderMarkdown('# Title\n\n<img src=x onerror="alert(1)">');
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("alert(1)");
});

test("MarkdownPreview renders the converted HTML into the DOM", () => {
  const html = renderToStaticMarkup(<MarkdownPreview content="# Hi" />);
  expect(html).toContain("<h1>Hi</h1>");
});

test("MarkdownPreview never surfaces a malicious payload's script into the DOM", () => {
  const html = renderToStaticMarkup(<MarkdownPreview content='<img src=x onerror="alert(1)">' />);
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("alert(1)");
});
