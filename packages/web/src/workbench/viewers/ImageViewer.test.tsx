import "../../testUtils/domTestSetup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { ImageViewer } from "./ImageViewer";

const fakeClient = { request: () => Promise.reject(new Error("not called")) } as unknown as RpcClient;

test("shows a loading state before the fetch resolves", () => {
  const html = renderToStaticMarkup(<ImageViewer path="a.png" client={fakeClient} />);
  expect(html).toContain("Loading");
});

/** A controllable fake `RpcClient` whose `request` promise the test resolves
 * or rejects on demand, so both the success and error branches of
 * ImageViewer's/PdfViewer's fetch effect can be exercised deterministically. */
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

test("renders the fetched image once fs/readBinary resolves", async () => {
  const { client, resolve } = deferredClient();
  const el = mount(<ImageViewer path="a.png" client={client} />);
  expect(el.textContent).toContain("Loading image");

  await act(async () => {
    resolve({ contentBase64: "Zm9v", mimeType: "image/png" });
    await Promise.resolve();
    await Promise.resolve();
  });

  const img = el.querySelector("img");
  expect(img).not.toBeNull();
  expect(img?.getAttribute("src")).toBe("data:image/png;base64,Zm9v");
});

test("renders an error message when fs/readBinary rejects", async () => {
  const { client, reject } = deferredClient();
  const el = mount(<ImageViewer path="a.png" client={client} />);

  await act(async () => {
    reject(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(el.textContent).toContain("Could not load image");
  expect(el.textContent).toContain("boom");
});
