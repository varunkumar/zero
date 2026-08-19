import "../../../../testSupport/domTestSetup";
import { describe, expect, test } from "bun:test";
import { flushSync } from "react-dom";
import { act } from "react";
import { mount } from "./index";

function fakeApi(overrides: Partial<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}> = {}) {
  const registered: { id: string; title: string; mount: (el: HTMLElement) => () => void }[] = [];
  const notifHandlers = new Map<string, (params: unknown) => void>();
  const requestFn = overrides.request ?? (async () => ({}));
  return {
    api: {
      client: {
        request: <R,>(method: string, params?: unknown): Promise<R> =>
          requestFn(method, params) as Promise<R>,
      },
      registerStatusBarItem: () => {},
      registerSidebarPanel: (panel: { id: string; title: string; mount: (el: HTMLElement) => () => void }) => registered.push(panel),
      onNotification: (method: string, handler: (params: unknown) => void) => {
        notifHandlers.set(method, handler);
        return () => notifHandlers.delete(method);
      },
    },
    registered,
    notifHandlers,
  };
}

describe("todos plugin UI", () => {
  test("mount registers a single sidebar panel titled TODOs", () => {
    const { api, registered } = fakeApi();
    const cleanup = mount(document.createElement("div"), api);
    expect(registered.length).toBe(1);
    expect(registered[0]!.id).toBe("todos");
    expect(registered[0]!.title).toBe("TODOs");
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
