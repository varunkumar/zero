import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { PdfViewer } from "./PdfViewer";

const fakeClient = { request: () => Promise.reject(new Error("not called")) } as unknown as RpcClient;

test("shows a loading state before the fetch resolves", () => {
  const html = renderToStaticMarkup(<PdfViewer path="a.pdf" client={fakeClient} />);
  expect(html).toContain("Loading");
});
