import "../../../../testSupport/domTestSetup";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { mount } from "./index";

function fakeApi(overrides?: {
  request?: (method: string, params?: unknown) => Promise<any>;
}) {
  const registered: { id: string; mount: (el: HTMLElement) => () => void }[] = [];
  const defaultRequest = async (method: string, params?: unknown): Promise<any> => ({});
  return {
    api: {
      client: { request: overrides?.request ?? defaultRequest },
      registerStatusBarItem: (item: { id: string; mount: (el: HTMLElement) => () => void }) => {
        registered.push(item);
      },
      registerSidebarPanel: () => {},
      onNotification: () => () => {},
      openFile: () => {},
    },
    registered,
  };
}

describe("git plugin UI", () => {
  test("mount registers a single status bar item", () => {
    const { api, registered } = fakeApi();
    const cleanup = mount(document.createElement("div"), api);
    expect(registered.length).toBe(1);
    expect(registered[0]!.id).toBe("git");
    cleanup();
  });

  test("the status bar item shows the file count from git/status", async () => {
    const { api, registered } = fakeApi({
      request: async (method: string) => {
        if (method === "git/status") {
          return { status: { branch: "main", dirtyCount: 2, ahead: 0, behind: 0, remoteUrl: null, files: [{ path: "a.ts", status: "modified" }, { path: "b.ts", status: "untracked" }] } };
        }
        return {};
      },
    });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    let cleanup: (() => void) | undefined;
    await act(async () => {
      cleanup = registered[0]!.mount(el);
      // The item's own mount() does an async fetch before rendering; flush microtasks.
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.textContent).toContain("main");
    expect(el.textContent).toContain("2");
    cleanup?.();
  });

  test("shows nothing when git/status returns a null status (not a git repo)", async () => {
    const { api, registered } = fakeApi({ request: async () => ({ status: null }) });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    let cleanup: (() => void) | undefined;
    await act(async () => {
      cleanup = registered[0]!.mount(el);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.textContent).toBe("");
    cleanup?.();
  });
});
