import { expect, test, mock } from "bun:test";
import { SettingsStore, DEFAULT_SETTINGS, normalizeSettings, type WorkbenchSettings } from "./store";

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

test("reconcile falls back to the default theme when the daemon value has an invalid theme", async () => {
  // `.zero/settings.json` is hand-editable, so the daemon can hand back junk.
  const store = new SettingsStore({ request: async () => ({ value: { theme: "solarized", sidebarWidth: 300, sidebarCollapsed: true } }) }, fakeStorage());
  const merged = await store.reconcile();
  expect(merged.theme).toBe(DEFAULT_SETTINGS.theme);
  expect(merged.sidebarWidth).toBe(300);
  expect(merged.sidebarCollapsed).toBe(true);
});

test("reconcile merges a partial daemon value with the defaults", async () => {
  const store = new SettingsStore({ request: async () => ({ value: { theme: "light" } }) }, fakeStorage());
  const merged = await store.reconcile();
  expect(merged).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
  expect(merged.sidebarWidth).toBe(DEFAULT_SETTINGS.sidebarWidth);
});

test("reconcile ignores a non-object daemon value", async () => {
  const store = new SettingsStore({ request: async () => ({ value: "nonsense" }) }, fakeStorage());
  expect(await store.reconcile()).toEqual(DEFAULT_SETTINGS);
});

test("localStorage hydration clamps an invalid theme and fills missing keys", () => {
  const storage = fakeStorage({ "zero.workbench": JSON.stringify({ theme: "neon", sidebarCollapsed: true }) });
  const store = new SettingsStore({ request: async () => ({ value: undefined }) }, storage);
  expect(store.getSnapshot()).toEqual({ ...DEFAULT_SETTINGS, sidebarCollapsed: true });
});

test("normalizeSettings rejects a non-numeric sidebarWidth", () => {
  expect(normalizeSettings({ sidebarWidth: "wide" }).sidebarWidth).toBe(DEFAULT_SETTINGS.sidebarWidth);
  expect(normalizeSettings({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(DEFAULT_SETTINGS.sidebarWidth);
  expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
});

test("subscribe notifies on update", () => {
  const store = new SettingsStore({ request: async () => ({ value: undefined }) }, fakeStorage());
  let received: unknown;
  store.subscribe((s) => { received = s; });
  store.update({ theme: "dark" });
  expect((received as { theme: string }).theme).toBe("dark");
});
