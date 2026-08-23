import "../../../../testSupport/domTestSetup";
import { describe, expect, test } from "bun:test";
import { flushSync } from "react-dom";
import { act } from "react";
import { mount } from "./index";

function fakeApi(overrides: Partial<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}> = {}) {
  const registered: { id: string; title: string; icon?: string; mount: (el: HTMLElement) => () => void }[] = [];
  const notifHandlers = new Map<string, (params: unknown) => void>();
  const opened: [string, number | undefined][] = [];
  const requestFn = overrides.request ?? (async () => ({}));
  return {
    api: {
      client: {
        request: <R,>(method: string, params?: unknown): Promise<R> =>
          requestFn(method, params) as Promise<R>,
      },
      registerStatusBarItem: () => {},
      registerSidebarPanel: (panel: { id: string; title: string; icon?: string; mount: (el: HTMLElement) => () => void }) => registered.push(panel),
      onNotification: (method: string, handler: (params: unknown) => void) => {
        notifHandlers.set(method, handler);
        return () => notifHandlers.delete(method);
      },
      openFile: (path: string, line?: number) => opened.push([path, line]),
    },
    registered,
    notifHandlers,
    opened,
  };
}

describe("todos plugin UI", () => {
  test("mount registers a single sidebar panel titled Tasks with an icon", () => {
    const { api, registered } = fakeApi();
    const cleanup = mount(document.createElement("div"), api);
    expect(registered.length).toBe(1);
    expect(registered[0]!.id).toBe("todos");
    expect(registered[0]!.title).toBe("Tasks");
    expect(registered[0]!.icon).toBe("☑");
    cleanup();
  });

  test("the panel lists entries from todos/list", async () => {
    const { api, registered } = fakeApi({
      request: async (method) => {
        if (method === "todos/list") {
          return { entries: [{ path: "a.ts", line: 3, kind: "TODO", text: "fix this" }] };
        }
        return {};
      },
    });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    let cleanup: () => void = () => {};
    act(() => {
      cleanup = registered[0]!.mount(el);
      flushSync(() => {});
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(el.textContent).toContain("a.ts");
    expect(el.textContent).toContain("fix this");
    cleanup();
  });

  test("clicking an entry opens that entry's file at its line", async () => {
    const { api, registered, opened } = fakeApi({
      request: async (method) => {
        if (method === "todos/list") {
          return { entries: [{ path: "src/a.ts", line: 7, kind: "TODO", text: "fix this" }] };
        }
        return {};
      },
    });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    let cleanup: () => void = () => {};
    act(() => {
      cleanup = registered[0]!.mount(el);
      flushSync(() => {});
    });
    await new Promise((r) => setTimeout(r, 10));

    const row = el.querySelector('[role="button"]');
    expect(row).not.toBeNull();
    // MouseEvent is taken off the element's own document rather than a
    // global: which jsdom setup installed the DOM (this package's or
    // packages/web's, when both suites share a process) decides which
    // globals exist, but ownerDocument.defaultView is always the right one.
    const win = row!.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent };
    act(() => {
      row!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      flushSync(() => {});
    });

    expect(opened).toEqual([["src/a.ts", 7]]);
    cleanup();
  });

  test("subscribes to fs/changed and re-fetches todos/list when it fires", async () => {
    let listCalls = 0;
    const { api, registered, notifHandlers } = fakeApi({
      request: async (method) => {
        if (method === "todos/list") {
          listCalls++;
          return { entries: [] };
        }
        return {};
      },
    });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    let cleanup: () => void = () => {};
    act(() => {
      cleanup = registered[0]!.mount(el);
      flushSync(() => {});
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(listCalls).toBe(1);

    act(() => {
      notifHandlers.get("fs/changed")?.({ path: "a.ts" });
      flushSync(() => {});
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(listCalls).toBe(2);
    cleanup();
  });
});
