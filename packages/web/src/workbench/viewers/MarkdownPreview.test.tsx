import "../../testUtils/domTestSetup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

function mount(el: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el));
  return container;
}

test("resolves a Markdown-relative image against the file's directory via fs/readBinary", async () => {
  let requestedPath = "";
  const client = {
    request: (_method: string, params: unknown) => {
      requestedPath = (params as { path: string }).path;
      return Promise.resolve({ contentBase64: "Zm9v", mimeType: "image/png" });
    },
  } as unknown as RpcClient;

  const el = mount(
    <MarkdownPreview content="![diagram](./assets/diagram.png)" path="docs/README.md" client={client} />,
  );

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(requestedPath).toBe("docs/assets/diagram.png");
  expect(el.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,Zm9v");
});

test("leaves absolute and data: image sources untouched", async () => {
  const client = { request: () => Promise.reject(new Error("should not be called")) } as unknown as RpcClient;
  const el = mount(
    <MarkdownPreview
      content="![a](https://example.com/a.png)\n\n![b](data:image/png;base64,Zm9v)"
      path="docs/README.md"
      client={client}
    />,
  );

  await act(async () => {
    await Promise.resolve();
  });

  const srcs = Array.from(el.querySelectorAll("img")).map((img) => img.getAttribute("src"));
  expect(srcs).toEqual(["https://example.com/a.png", "data:image/png;base64,Zm9v"]);
});

test("without a path/client, relative image sources are left as-is (no crash)", () => {
  const el = mount(<MarkdownPreview content="![diagram](./diagram.png)" />);
  expect(el.querySelector("img")?.getAttribute("src")).toBe("./diagram.png");
});
