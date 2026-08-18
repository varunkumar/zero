import "../../testUtils/domTestSetup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { PdfViewer } from "./PdfViewer";

const fakeClient = { request: () => Promise.reject(new Error("not called")) } as unknown as RpcClient;

test("shows a loading state before the fetch resolves", () => {
  const html = renderToStaticMarkup(<PdfViewer path="a.pdf" client={fakeClient} />);
  expect(html).toContain("Loading");
});

/** A controllable fake `RpcClient` whose `request` promise the test resolves
 * or rejects on demand, so both the success and error branches of
 * PdfViewer's fetch effect can be exercised deterministically. */
function deferredClient(): { client: RpcClient; resolve: (v: unknown) => void; reject: (e: unknown) => void } {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const client = { request: () => promise } as unknown as RpcClient;
  return { client, resolve, reject };
}

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

test("renders a PDF embed once fs/readBinary resolves", async () => {
  const { client, resolve } = deferredClient();
  const el = mount(<PdfViewer path="a.pdf" client={client} />);
  expect(el.textContent).toContain("Loading PDF");

  await act(async () => {
    resolve({ contentBase64: "Zm9v", mimeType: "application/pdf" });
    await Promise.resolve();
    await Promise.resolve();
  });

  const embed = el.querySelector("embed");
  expect(embed).not.toBeNull();
  expect(embed?.getAttribute("type")).toBe("application/pdf");
  expect(embed?.getAttribute("src")).toStartWith("blob:");
});

test("renders an error message when fs/readBinary rejects", async () => {
  const { client, reject } = deferredClient();
  const el = mount(<PdfViewer path="a.pdf" client={client} />);

  await act(async () => {
    reject(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(el.textContent).toContain("Could not load PDF");
  expect(el.textContent).toContain("boom");
});
