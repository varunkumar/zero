// `bun:test` runs source directly under Bun's own runtime, which has no
// browser DOM (no `window`/`document`) — unlike a real page load, where
// MarkdownPreview/ImageViewer/PdfViewer always run inside a browser. Any
// test that needs to mount a component with `react-dom/client` (to let
// `useEffect` actually run) or that calls `renderMarkdown`'s DOMPurify pass
// directly must register a DOM before doing either.
//
// jsdom, not happy-dom: DOMPurify's tag/attribute allow-list checks rely on
// DOM behavior (e.g. `Node`/`Element` identity and namespace handling) that
// happy-dom doesn't fully replicate — under happy-dom, DOMPurify silently
// drops otherwise-allowed tags like `<h1>`. jsdom matches DOMPurify's own
// supported/tested environment.
//
// Import this module for its side effect, before importing the component
// under test:
//
//   import "../../testUtils/domTestSetup";
//   import { ImageViewer } from "./ImageViewer";
//
// Registration is idempotent and guarded so importing it from multiple test
// files in the same `bun test` run is safe.
import { JSDOM } from "jsdom";

if (typeof window === "undefined") {
  // Tells React's `act()` (from "react", not the deprecated
  // "react-dom/test-utils" one) that this environment is a deliberate test
  // harness, silencing its "not configured to support act" warning.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.Element = dom.window.Element;
  g.Text = dom.window.Text;
  g.DocumentFragment = dom.window.DocumentFragment;
  g.Event = dom.window.Event;
  g.CustomEvent = dom.window.CustomEvent;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
