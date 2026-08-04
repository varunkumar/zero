import { expect, test, mock } from "bun:test";
import { SettingsStore, DEFAULT_SETTINGS, type WorkbenchSettings } from "./store";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
}

test("getSnapshot returns defaults when localStorage is empty", () => {
  const store = new SettingsStore({ request: async () => ({ value: undefined }) }, fakeStorage());
  expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS);
});

test("getSnapshot hydrates from localStorage synchronously", () => {
  const cached: WorkbenchSettings = { theme: "dark", sidebarWidth: 300, sidebarCollapsed: true };
  const store = new SettingsStore({ request: async () => ({ value: undefined }) }, fakeStorage({ "zero.workbench": JSON.stringify(cached) }));
  expect(store.getSnapshot()).toEqual(cached);
});

test("reconcile prefers the daemon value over localStorage on conflict", async () => {
  const cached: WorkbenchSettings = { theme: "light", sidebarWidth: 200, sidebarCollapsed: false };
  const daemonValue: WorkbenchSettings = { theme: "dark", sidebarWidth: 999, sidebarCollapsed: true };
  const storage = fakeStorage({ "zero.workbench": JSON.stringify(cached) });
  const store = new SettingsStore({ request: async () => ({ value: daemonValue }) }, storage);
  const merged = await store.reconcile();
  expect(merged).toEqual(daemonValue);
  expect(store.getSnapshot()).toEqual(daemonValue);
  expect(JSON.parse(storage.map.get("zero.workbench")!)).toEqual(daemonValue);
});

test("reconcile keeps localStorage value when daemon has none", async () => {
  const cached: WorkbenchSettings = { theme: "dark", sidebarWidth: 240, sidebarCollapsed: false };
  const storage = fakeStorage({ "zero.workbench": JSON.stringify(cached) });
  const store = new SettingsStore({ request: async () => ({ value: undefined }) }, storage);
  const merged = await store.reconcile();
  expect(merged).toEqual(cached);
});

test("update writes localStorage synchronously and debounces the daemon write", async () => {
  const requests: unknown[] = [];
  const storage = fakeStorage();
  const store = new SettingsStore({ request: async (method, params) => { requests.push([method, params]); return {}; } }, storage);
  store.update({ theme: "dark" });
  expect(JSON.parse(storage.map.get("zero.workbench")!).theme).toBe("dark");
  expect(requests.length).toBe(0); // debounced, not sent yet
  await new Promise((r) => setTimeout(r, 600));
  expect(requests.length).toBe(1);
  expect(requests[0]).toEqual(["settings/set", { key: "workbench", value: store.getSnapshot() }]);
});

test("subscribe notifies on update", () => {
  const store = new SettingsStore({ request: async () => ({ value: undefined }) }, fakeStorage());
  let received: unknown;
  store.subscribe((s) => { received = s; });
  store.update({ theme: "dark" });
  expect((received as { theme: string }).theme).toBe("dark");
});
