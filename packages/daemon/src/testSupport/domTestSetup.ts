// Ports packages/web/src/testUtils/domTestSetup.ts's approach for
// packages/daemon: bun:test has no browser DOM, and plugin UI bundles
// (packages/daemon/src/plugins/*/ui/src/*) render real React components
// with react-dom/client, which needs one. Import this module for its
// side effect before importing the component under test.
import { JSDOM } from "jsdom";

if (typeof window === "undefined") {
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
