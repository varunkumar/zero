import "../../testUtils/domTestSetup";
import { expect, test } from "bun:test";
import { loadPluginUis } from "./loader";
import { StatusBarRegistry, SidebarPanelRegistry } from "./registries";
import { NotificationHub } from "./notifications";
import type { PluginListEntry, RpcClient } from "@zero/protocol";

function fakeClient(): RpcClient {
  return { request: async () => ({}), notify: () => {}, onNotification: () => {}, onRequest: () => {} } as unknown as RpcClient;
}

function makeEntry(id: string, hasUi: boolean, enabled = true): PluginListEntry {
  return {
    id, name: id, version: "0.0.0",
    health: { ok: true },
    enabled,
    contributions: hasUi ? { ui: true as const } : {},
  };
}

test("loads every plugin with a ui contribution and calls its mount", async () => {
  const statusBarRegistry = new StatusBarRegistry();
  const sidebarPanelRegistry = new SidebarPanelRegistry();
  const hub = new NotificationHub();
  const mounted: string[] = [];

  const cleanup = await loadPluginUis({
    client: fakeClient(),
    plugins: [makeEntry("git", true), makeEntry("no-ui-plugin", false)],
    statusBarRegistry, sidebarPanelRegistry, hub,
    openFile: () => {},
    importModule: async (url) => {
      mounted.push(url);
      return { mount: () => () => {} };
    },
  });

  expect(mounted).toEqual(["/plugins/git/ui.js"]);
  cleanup();
});

test("a plugin whose import() rejects does not prevent others from loading", async () => {
  const statusBarRegistry = new StatusBarRegistry();
  const sidebarPanelRegistry = new SidebarPanelRegistry();
  const hub = new NotificationHub();
  const mountedIds: string[] = [];

  await loadPluginUis({
    client: fakeClient(),
    plugins: [makeEntry("broken", true), makeEntry("ok", true)],
    statusBarRegistry, sidebarPanelRegistry, hub,
    openFile: () => {},
    importModule: async (url) => {
      if (url.includes("broken")) throw new Error("404");
      mountedIds.push(url);
      return { mount: () => () => {} };
    },
  });

  expect(mountedIds).toEqual(["/plugins/ok/ui.js"]);
});

test("a plugin whose mount() throws does not prevent others from loading", async () => {
  const statusBarRegistry = new StatusBarRegistry();
  const sidebarPanelRegistry = new SidebarPanelRegistry();
  const hub = new NotificationHub();
  const mountCalls: string[] = [];

  await loadPluginUis({
    client: fakeClient(),
    plugins: [makeEntry("broken", true), makeEntry("ok", true)],
    statusBarRegistry, sidebarPanelRegistry, hub,
    openFile: () => {},
    importModule: async (url) => ({
      mount: () => {
        if (url.includes("broken")) throw new Error("boom");
        mountCalls.push(url);
        return () => {};
      },
    }),
  });

  expect(mountCalls).toEqual(["/plugins/ok/ui.js"]);
});

test("the returned cleanup calls every successfully-mounted plugin's cleanup", async () => {
  const statusBarRegistry = new StatusBarRegistry();
  const sidebarPanelRegistry = new SidebarPanelRegistry();
  const hub = new NotificationHub();
  const cleanupCalls: string[] = [];

  const cleanup = await loadPluginUis({
    client: fakeClient(),
    plugins: [makeEntry("a", true), makeEntry("b", true)],
    statusBarRegistry, sidebarPanelRegistry, hub,
    openFile: () => {},
    importModule: async (url) => ({ mount: () => () => cleanupCalls.push(url) }),
  });
  cleanup();

  expect(cleanupCalls.sort()).toEqual(["/plugins/a/ui.js", "/plugins/b/ui.js"]);
});

test("skips a disabled plugin's ui contribution even though it's healthy", async () => {
  const statusBarRegistry = new StatusBarRegistry();
  const sidebarPanelRegistry = new SidebarPanelRegistry();
  const hub = new NotificationHub();
  let calls = 0;

  await loadPluginUis({
    client: fakeClient(),
    plugins: [makeEntry("todos", true, false)],
    statusBarRegistry, sidebarPanelRegistry, hub,
    openFile: () => {},
    importModule: async () => { calls++; return { mount: () => () => {} }; },
  });

  expect(calls).toBe(0);
});

test("skips plugins with no ui contribution entirely", async () => {
  const statusBarRegistry = new StatusBarRegistry();
  const sidebarPanelRegistry = new SidebarPanelRegistry();
  const hub = new NotificationHub();
  let calls = 0;

  await loadPluginUis({
    client: fakeClient(),
    plugins: [makeEntry("no-ui", false)],
    statusBarRegistry, sidebarPanelRegistry, hub,
    openFile: () => {},
    importModule: async () => { calls++; return { mount: () => () => {} }; },
  });

  expect(calls).toBe(0);
});
