import "../../testUtils/domTestSetup";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { detectFormat, renderFormattedMessage } from "./messageFormatting";

test("detectFormat recognizes JSON objects and arrays", () => {
  expect(detectFormat('{"a": 1, "b": [1, 2]}')).toBe("json");
  expect(detectFormat("[1, 2, 3]")).toBe("json");
});

test("detectFormat recognizes a single-root XML document", () => {
  expect(detectFormat("<note><to>You</to><body>Hi</body></note>")).toBe("xml");
  expect(detectFormat('<?xml version="1.0"?><root/>')).toBe("xml");
});

test("detectFormat recognizes HTML markup", () => {
  expect(detectFormat("<div><p>Hello <b>world</b></p></div>")).toBe("html");
});

test("detectFormat recognizes YAML-shaped key/value text", () => {
  expect(detectFormat("name: zero\nversion: 1.0\nfeatures:\n  - chat\n  - tui")).toBe("yaml");
});

test("detectFormat recognizes uniform comma-delimited rows as CSV", () => {
  expect(detectFormat("a,b,c\n1,2,3\n4,5,6")).toBe("csv");
});

test("detectFormat recognizes Markdown syntax", () => {
  expect(detectFormat("# Heading\n\nSome **bold** text and a list:\n- one\n- two")).toBe("markdown");
  expect(detectFormat("Here is code:\n```js\nconst x = 1;\n```")).toBe("markdown");
});

test("detectFormat falls back to plain text", () => {
  expect(detectFormat("Just a normal sentence with no special structure.")).toBe("plain");
});

test("renderFormattedMessage renders Markdown headings/lists as real HTML, sanitized", () => {
  const html = renderToStaticMarkup(<>{renderFormattedMessage("# Title\n\n- one\n- two")}</>);
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<li>one</li>");
});

test("renderFormattedMessage keeps syntax highlighting for fenced code inside Markdown", () => {
  const html = renderToStaticMarkup(<>{renderFormattedMessage("Some code:\n```js\nconst x = 1;\n```")}</>);
  expect(html).toContain("zero-tok-keyword");
});

test("renderFormattedMessage pretty-prints and highlights JSON", () => {
  const html = renderToStaticMarkup(<>{renderFormattedMessage('{"a":1}')}</>);
  expect(html).toContain("\n");
  expect(html).toContain("zero-tok-property");
});

test("renderFormattedMessage sanitizes a raw HTML message instead of executing it", () => {
  const html = renderToStaticMarkup(<>{renderFormattedMessage('<div>hi<img src=x onerror="alert(1)"></div>')}</>);
  expect(html).not.toContain("onerror");
  expect(html).toContain("hi");
});

test("renderFormattedMessage renders plain text unchanged (aside from inline-code styling)", () => {
  const html = renderToStaticMarkup(<>{renderFormattedMessage("just some plain prose")}</>);
  expect(html).toContain("just some plain prose");
});
