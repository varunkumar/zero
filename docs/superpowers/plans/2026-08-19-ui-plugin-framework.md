# UI Plugin Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let daemon-side plugins (`git`, `todos`) contribute a browser UI —
a status bar item, a sidebar panel — that `@zero/web` (and therefore
`packages/desktop`, which just wraps `@zero/web`'s build) loads and mounts
at runtime, without editing `@zero/web`'s own source per plugin.

**Architecture:** A plugin optionally ships a self-contained JS bundle under
its own `ui/` folder, bundled with `Bun.build()` (react/react-dom included,
not externalized). The daemon serves it at `GET /plugins/:id/ui.js`. The web
client dynamically `import()`s each contributing plugin's bundle at startup
and calls its exported `mount(container, api)`, where `api` exposes the RPC
client, a scoped notification subscription, and two registries (status bar
items, sidebar panels) that `StatusBar`/`Workbench` render from alongside
their existing hardcoded items.

**Tech Stack:** Bun (`Bun.build`), TypeScript, React 18 (bundled per-plugin,
not shared with the host), Zod (daemon RPC schemas), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-19-ui-plugin-framework-design.md`

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs.
- All packages: TypeScript `strict: true`, ESM only.
- Daemon binds `127.0.0.1` only.
- The editor must stay fully usable when no plugin/model is available —
  degrade the failing subsystem only, never break editing.
- `packages/vscode` and the Claude Code plugin are unaffected — this plan
  touches only `packages/daemon`, `packages/protocol`, `packages/web`.
- No sandboxing (iframes/postMessage) — plugin UI code runs in the main page
  context, same trust level as the rest of `@zero/web`.
- Each plugin's UI bundle is fully self-contained (bundles its own
  react/react-dom) and exposes an imperative `mount(container, api) →
  cleanup` — never a React component the host renders inside its own tree.

---

## File Structure

```
packages/daemon/
  src/mime.ts                          (existing — untouched)
  src/server.ts                        (modify: new /plugins/:id/ui.js route)
  src/server.test.ts                   (modify: route tests)
  src/plugins/types.ts                 (modify: contributions.ui field)
  package.json                         (modify: add react-dom dep, build:plugin-ui script)
  scripts/build-plugin-ui.ts           (new: Bun.build() driver)
  src/testSupport/domTestSetup.ts      (new: jsdom shim for React-in-bun:test, ported from packages/web)
  src/plugins/git/
    ui/src/index.tsx                   (new)
    ui/src/index.test.tsx              (new)
    ui/build.test.ts                   (new: Bun.build() smoke test)
  src/plugins/todos/
    ui/src/index.tsx                   (new)
    ui/src/index.test.tsx              (new)
    ui/build.test.ts                   (new: Bun.build() smoke test)

packages/protocol/
  src/messages.ts                      (modify: PluginListEntry.contributions.ui)

packages/web/
  src/workbench/plugins/
    registries.ts                      (new: StatusBarRegistry, SidebarPanelRegistry)
    registries.test.ts                 (new)
    notifications.ts                   (new: NotificationHub)
    notifications.test.ts              (new)
    loader.ts                          (new: discovers + imports plugin UI bundles)
    loader.test.ts                     (new)
    PluginSlot.tsx                     (new: mounts an imperative panel/item into a ref'd div)
  src/workbench/StatusBar.tsx          (modify: render registry.list())
  src/workbench/layout/Workbench.tsx   (modify: wire loader, registries, hub, widen sidebarView)
  src/workbench/layout/Workbench.test.tsx (modify: cover the plugin-panel branch, if this file exists — else add alongside existing Workbench tests)
```

---

### Task 1: Daemon — `ui` contribution field on the plugin manifest

**Files:**
- Modify: `packages/daemon/src/plugins/types.ts`
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/daemon/src/plugins/host.test.ts`

**Interfaces:**
- Produces: `PluginManifest.contributions.ui?: { entry: string }` (daemon-side type). `PluginListEntry.contributions.ui?: { entry: string }` (protocol-side type, what `plugin/list` returns over the wire).

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/src/plugins/host.test.ts` (same file already has `makeHost()` and a `demo/ping` factory pattern — add a new test using the same helper):

```ts
test("activateBuiltins passes through a ui contribution untouched", async () => {
  const { host, rpc } = makeHost();
  const factory = (): ZeroPlugin => ({
    manifest: {
      id: "demo-ui", name: "Demo UI", version: "1.0.0",
      contributions: { ui: { entry: "ui/dist/index.js" } },
    },
    activate() {},
  });
  await host.activateBuiltins([factory]);
  const list = host.list();
  expect(list.plugins.find((p) => p.id === "demo-ui")?.contributions.ui)
    .toEqual({ entry: "ui/dist/index.js" });
  void rpc; // unused in this test, keep destructure consistent with makeHost()'s return shape
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/plugins/host.test.ts -t "ui contribution"`
Expected: FAIL with a TypeScript error (`ui` does not exist on type `contributions`) — since `bun test` type-checks via Bun's transpiler this shows as a runtime property mismatch or a red squiggle caught by `bun run typecheck`; verify with `bun run typecheck` if `bun test` itself doesn't fail on the excess property.

- [ ] **Step 3: Add the field**

In `packages/daemon/src/plugins/types.ts`, change:

```ts
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  contributions: {
    rpcMethods?: string[];
    contextProviders?: string[];
    tools?: string[];
    commands?: string[];
    ui?: { entry: string };
  };
}
```

In `packages/protocol/src/messages.ts`, find `PluginListEntry` (currently around line 110-121) and add the matching field to its `contributions` object:

```ts
export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  health: PluginHealthInfo;
  contributions: {
    rpcMethods?: string[];
    contextProviders?: string[];
    tools?: string[];
    commands?: string[];
    ui?: { entry: string };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/plugins/host.test.ts`
Expected: PASS, all existing tests in the file still pass too.

- [ ] **Step 5: Run full typecheck**

Run: `bun run typecheck`
Expected: no new errors (5 pre-existing errors in `lsp/client.ts`/`pty.ts` are unrelated and already present on `main`).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/plugins/types.ts packages/daemon/src/plugins/host.test.ts packages/protocol/src/messages.ts
git commit -m "feat(daemon): add optional ui contribution to plugin manifests"
```

---

### Task 2: Daemon — serve `GET /plugins/:id/ui.js`

**Files:**
- Modify: `packages/daemon/src/server.ts`
- Test: `packages/daemon/src/server.test.ts`

**Interfaces:**
- Consumes: `DaemonOptions` (`packages/daemon/src/server.ts:5`, currently `{ root: string; port?: number; token?: string; webDist?: string; gatewayPort?: number }`).
- Produces: `DaemonOptions.pluginsDir?: string` — absolute path to the directory containing one subfolder per plugin id (e.g. `.../packages/daemon/src/plugins`). When set, `GET /plugins/:id/ui.js` serves `<pluginsDir>/<id>/ui/dist/index.js` if it exists.

- [ ] **Step 1: Write the failing tests**

Add to `packages/daemon/src/server.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GET /plugins/:id/ui.js serves the bundle with a JS content-type", async () => {
  const pluginsDir = mkdtempSync(join(tmpdir(), "zero-plugins-"));
  mkdirSync(join(pluginsDir, "demo", "ui", "dist"), { recursive: true });
  writeFileSync(join(pluginsDir, "demo", "ui", "dist", "index.js"), "export function mount(){}");

  const d = createDaemon({ root: "/tmp", pluginsDir });
  const res = await fetch(`http://127.0.0.1:${d.port}/plugins/demo/ui.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(await res.text()).toContain("export function mount");
  d.stop();
});

test("GET /plugins/:id/ui.js 404s for an unknown plugin id", async () => {
  const pluginsDir = mkdtempSync(join(tmpdir(), "zero-plugins-"));
  const d = createDaemon({ root: "/tmp", pluginsDir });
  const res = await fetch(`http://127.0.0.1:${d.port}/plugins/nope/ui.js`);
  expect(res.status).toBe(404);
  d.stop();
});

test("GET /plugins/:id/ui.js 404s when pluginsDir isn't configured", async () => {
  const d = createDaemon({ root: "/tmp" });
  const res = await fetch(`http://127.0.0.1:${d.port}/plugins/demo/ui.js`);
  expect(res.status).toBe(404);
  d.stop();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/daemon/src/server.test.ts -t "plugins/:id/ui.js"`
Expected: FAIL — all three requests fall through to the existing `webDist`/`"zero daemon"` branches (404 test may accidentally pass; the 200 test will fail since nothing serves the file yet).

- [ ] **Step 3: Add the route**

In `packages/daemon/src/server.ts`, extend `DaemonOptions` (line 5) and add the branch in `fetch` before the `/rpc` check is fine, but simplest is right after it and before the `webDist` block:

```ts
export interface DaemonOptions {
  root: string; port?: number; token?: string; webDist?: string; gatewayPort?: number;
  pluginsDir?: string;
}
```

```ts
      if (url.pathname === "/rpc") {
        if (url.searchParams.get("token") !== token)
          return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const pluginUiMatch = url.pathname.match(/^\/plugins\/([^/]+)\/ui\.js$/);
      if (pluginUiMatch) {
        if (!opts.pluginsDir) return new Response("not found", { status: 404 });
        const id = pluginUiMatch[1];
        const file = Bun.file(`${opts.pluginsDir}/${id}/ui/dist/index.js`);
        return file.exists().then((ok) =>
          ok
            ? new Response(file, { headers: { "Content-Type": "text/javascript" } })
            : new Response("not found", { status: 404 }));
      }
      if (opts.webDist) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/daemon/src/server.test.ts`
Expected: PASS, all existing tests in the file still pass.

- [ ] **Step 5: Wire `pluginsDir` in `main.ts`**

In `packages/daemon/src/main.ts`, `startZero` currently does `const daemon = createDaemon(opts);` at line 27 (verify exact line with `grep -n "createDaemon(opts)" packages/daemon/src/main.ts` before editing, since Task 1's edits may have shifted line numbers slightly). Change to pass `pluginsDir`, resolved relative to this module (the daemon's own `plugins/` folder sits alongside `main.ts`):

```ts
export async function startZero(opts: DaemonOptions) {
  const pluginsDir = new URL("./plugins", import.meta.url).pathname;
  const daemon = createDaemon({ ...opts, pluginsDir: opts.pluginsDir ?? pluginsDir });
```

This lets callers (and `startZero`'s own test suite in `main.test.ts`, if it ever needs to point at a fake plugin directory) override `pluginsDir` explicitly, while defaulting to the real `plugins/` folder in normal operation. Note this is a separate, optional override on top of `createDaemon`'s own `pluginsDir` option from Step 1-4 above, which this task's `server.test.ts` tests already exercise directly.

- [ ] **Step 6: Run the daemon test suite**

Run: `bun test packages/daemon`
Expected: same pass count as before this task plus the 3 new tests, no new failures (only the pre-existing 3 Ollama-dependent failures in `main.test.ts` remain).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/server.ts packages/daemon/src/server.test.ts packages/daemon/src/main.ts
git commit -m "feat(daemon): serve plugin UI bundles at GET /plugins/:id/ui.js"
```

---

### Task 3: Daemon — `Bun.build()` driver for plugin UI bundles

**Files:**
- Create: `packages/daemon/scripts/build-plugin-ui.ts`
- Modify: `packages/daemon/package.json`

**Interfaces:**
- Consumes: nothing from other tasks (standalone build script).
- Produces: a `build:plugin-ui` bun script that, given `packages/daemon/src/plugins/<id>/ui/src/index.tsx` exists, bundles it to `packages/daemon/src/plugins/<id>/ui/dist/index.js`. Tasks 9 and 10 rely on this script existing and this exact input/output path convention.

- [ ] **Step 1: Write the script**

```ts
// packages/daemon/scripts/build-plugin-ui.ts
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const pluginsDir = new URL("../src/plugins", import.meta.url).pathname;

async function main() {
  const ids = await readdir(pluginsDir, { withFileTypes: true });
  let built = 0;
  for (const entry of ids) {
    if (!entry.isDirectory()) continue;
    const entryPoint = join(pluginsDir, entry.name, "ui", "src", "index.tsx");
    const file = Bun.file(entryPoint);
    if (!(await file.exists())) continue;
    const outdir = join(pluginsDir, entry.name, "ui", "dist");
    const result = await Bun.build({
      entrypoints: [entryPoint],
      outdir,
      naming: "index.js",
      target: "browser",
      format: "esm",
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`build failed for plugin UI: ${entry.name}`);
    }
    built++;
    console.log(`built ${entry.name}/ui/dist/index.js`);
  }
  console.log(`${built} plugin UI bundle(s) built`);
}

void main();
```

- [ ] **Step 2: Add the package script and dependencies**

In `packages/daemon/package.json`, add to `"scripts"`:

```json
"build:plugin-ui": "bun scripts/build-plugin-ui.ts"
```

`react` is already a dependency (`^18.3.1`, used by the CLI's ink TUI). Add `react-dom` to `"dependencies"` at the same version range, and `@types/react-dom` to `"devDependencies"` (matching the existing `@types/react` entry):

```json
"react-dom": "^18.3.1"
```
```json
"@types/react-dom": "^18.3.0"
```

- [ ] **Step 3: Run `bun install`**

Run: `bun install`
Expected: lockfile updates, no errors.

- [ ] **Step 4: Verify the script runs cleanly with zero plugin UIs present**

Run: `cd packages/daemon && bun run build:plugin-ui`
Expected: prints `0 plugin UI bundle(s) built` (no `ui/src/index.tsx` exists yet — Tasks 9/10 add the first ones) and exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/scripts/build-plugin-ui.ts packages/daemon/package.json bun.lock
git commit -m "feat(daemon): add Bun.build() driver for plugin UI bundles"
```

---

### Task 4: Web — notification pub/sub hub

**Files:**
- Create: `packages/web/src/workbench/plugins/notifications.ts`
- Test: `packages/web/src/workbench/plugins/notifications.test.ts`

**Interfaces:**
- Produces: `class NotificationHub { subscribe(method: string, handler: (params: unknown) => void): () => void; dispatch(method: string, params: unknown): void }`. Task 7 wires this into `Workbench.tsx`'s existing single `client.onNotification` call and exposes `subscribe` through the plugin API in Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/workbench/plugins/notifications.test.ts
import { expect, test } from "bun:test";
import { NotificationHub } from "./notifications";

test("dispatch calls every subscriber registered for that method", () => {
  const hub = new NotificationHub();
  const calls: unknown[] = [];
  hub.subscribe("fs/changed", (p) => calls.push(p));
  hub.subscribe("fs/changed", (p) => calls.push(p));
  hub.dispatch("fs/changed", { path: "a.ts" });
  expect(calls).toEqual([{ path: "a.ts" }, { path: "a.ts" }]);
});

test("dispatch does not call subscribers of a different method", () => {
  const hub = new NotificationHub();
  const calls: unknown[] = [];
  hub.subscribe("fs/changed", (p) => calls.push(p));
  hub.dispatch("pty/output", { sessionId: "x", data: "y" });
  expect(calls).toEqual([]);
});

test("the unsubscribe function returned by subscribe removes only that handler", () => {
  const hub = new NotificationHub();
  const calls: string[] = [];
  const unsubA = hub.subscribe("fs/changed", () => calls.push("a"));
  hub.subscribe("fs/changed", () => calls.push("b"));
  unsubA();
  hub.dispatch("fs/changed", {});
  expect(calls).toEqual(["b"]);
});

test("dispatch with no subscribers for a method is a no-op", () => {
  const hub = new NotificationHub();
  expect(() => hub.dispatch("nothing/here", {})).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/web/src/workbench/plugins/notifications.test.ts`
Expected: FAIL — `./notifications` module does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/workbench/plugins/notifications.ts

/** Fans a single `client.onNotification` callback out to per-method
 * subscribers. RpcClient.onNotification is single-slot (a second call
 * silently replaces the first), so every consumer of daemon notifications -
 * built-in workbench features and plugin UI alike - must share one
 * registration; this is that shared dispatch point. */
export class NotificationHub {
  #subscribers = new Map<string, Set<(params: unknown) => void>>();

  subscribe(method: string, handler: (params: unknown) => void): () => void {
    let set = this.#subscribers.get(method);
    if (!set) {
      set = new Set();
      this.#subscribers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  dispatch(method: string, params: unknown): void {
    for (const handler of this.#subscribers.get(method) ?? []) handler(params);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/web/src/workbench/plugins/notifications.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/plugins/notifications.ts packages/web/src/workbench/plugins/notifications.test.ts
git commit -m "feat(web): add NotificationHub for shared daemon-notification fan-out"
```

---

### Task 5: Web — status bar / sidebar panel registries

**Files:**
- Create: `packages/web/src/workbench/plugins/registries.ts`
- Test: `packages/web/src/workbench/plugins/registries.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  interface StatusBarItem { id: string; mount(el: HTMLElement): () => void }
  class StatusBarRegistry {
    register(item: StatusBarItem): void;
    unregister(id: string): void;
    list(): StatusBarItem[];
  }
  interface SidebarPanelSpec { id: string; title: string; icon?: string; mount(el: HTMLElement): () => void }
  class SidebarPanelRegistry {
    register(panel: SidebarPanelSpec): void;
    unregister(id: string): void;
    get(id: string): SidebarPanelSpec | undefined;
    list(): SidebarPanelSpec[];
  }
  ```
  Task 6 (plugin API) exposes `registerStatusBarItem`/`registerSidebarPanel` backed by these. Task 8 (`StatusBar.tsx`) renders `StatusBarRegistry.list()`. Task 7 (`Workbench.tsx`) renders `SidebarPanelRegistry.list()`/`.get()`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/src/workbench/plugins/registries.test.ts
import { expect, test } from "bun:test";
import { StatusBarRegistry, SidebarPanelRegistry } from "./registries";

test("StatusBarRegistry: register/list/unregister", () => {
  const reg = new StatusBarRegistry();
  reg.register({ id: "git", mount: () => () => {} });
  expect(reg.list().map((i) => i.id)).toEqual(["git"]);
  reg.unregister("git");
  expect(reg.list()).toEqual([]);
});

test("StatusBarRegistry: registering the same id twice replaces it", () => {
  const reg = new StatusBarRegistry();
  let mounted = "";
  reg.register({ id: "git", mount: () => { mounted = "first"; return () => {}; } });
  reg.register({ id: "git", mount: () => { mounted = "second"; return () => {}; } });
  expect(reg.list().length).toBe(1);
  reg.list()[0]!.mount(document.createElement("div"));
  expect(mounted).toBe("second");
});

test("SidebarPanelRegistry: register/get/list/unregister", () => {
  const reg = new SidebarPanelRegistry();
  reg.register({ id: "todos", title: "TODOs", mount: () => () => {} });
  expect(reg.get("todos")?.title).toBe("TODOs");
  expect(reg.list().map((p) => p.id)).toEqual(["todos"]);
  reg.unregister("todos");
  expect(reg.get("todos")).toBeUndefined();
  expect(reg.list()).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/web/src/workbench/plugins/registries.test.ts`
Expected: FAIL — `./registries` module does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/workbench/plugins/registries.ts

export interface StatusBarItem {
  id: string;
  mount(el: HTMLElement): () => void;
}

export class StatusBarRegistry {
  #items = new Map<string, StatusBarItem>();

  register(item: StatusBarItem): void {
    this.#items.set(item.id, item);
  }

  unregister(id: string): void {
    this.#items.delete(id);
  }

  list(): StatusBarItem[] {
    return [...this.#items.values()];
  }
}

export interface SidebarPanelSpec {
  id: string;
  title: string;
  icon?: string;
  mount(el: HTMLElement): () => void;
}

export class SidebarPanelRegistry {
  #panels = new Map<string, SidebarPanelSpec>();

  register(panel: SidebarPanelSpec): void {
    this.#panels.set(panel.id, panel);
  }

  unregister(id: string): void {
    this.#panels.delete(id);
  }

  get(id: string): SidebarPanelSpec | undefined {
    return this.#panels.get(id);
  }

  list(): SidebarPanelSpec[] {
    return [...this.#panels.values()];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/web/src/workbench/plugins/registries.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/plugins/registries.ts packages/web/src/workbench/plugins/registries.test.ts
git commit -m "feat(web): add StatusBarRegistry and SidebarPanelRegistry"
```

---

### Task 6: Web — `PluginSlot` component and plugin UI loader

**Files:**
- Create: `packages/web/src/workbench/plugins/PluginSlot.tsx`
- Create: `packages/web/src/workbench/plugins/loader.ts`
- Test: `packages/web/src/workbench/plugins/loader.test.ts`

**Interfaces:**
- Consumes: `NotificationHub` (Task 4), `StatusBarRegistry`/`SidebarPanelRegistry` (Task 5), `RpcClient` (`@zero/protocol`), `PluginListResult`/`PluginListEntry` (`@zero/protocol`, extended in Task 1).
- Produces:
  ```ts
  interface ZeroUiPluginApi {
    client: RpcClient;
    registerStatusBarItem(item: StatusBarItem): void;
    registerSidebarPanel(panel: SidebarPanelSpec): void;
    onNotification(method: string, handler: (params: unknown) => void): () => void;
  }
  interface PluginUiModule { mount(container: HTMLElement, api: ZeroUiPluginApi): () => void }
  function loadPluginUis(opts: {
    client: RpcClient;
    plugins: PluginListEntry[];
    statusBarRegistry: StatusBarRegistry;
    sidebarPanelRegistry: SidebarPanelRegistry;
    hub: NotificationHub;
    importModule?: (url: string) => Promise<PluginUiModule>; // injection point for tests
  }): Promise<() => void> // returns a combined cleanup calling every loaded plugin's own cleanup
  ```
  `<PluginSlot mount={...} />` (a generic imperative-mount wrapper) — Task 7 and Task 8 both use it: `PluginSlot` takes `{ mount(el: HTMLElement): () => void }` and handles the `useRef`+`useEffect` dance once, so `StatusBar` and `Workbench`'s sidebar don't duplicate it.

- [ ] **Step 1: Write `PluginSlot.tsx`** (no test file for this one — it's a 15-line effect wrapper exercised indirectly by Task 7/8's component tests; a dedicated unit test would just re-assert React's own `useEffect` semantics)

```tsx
// packages/web/src/workbench/plugins/PluginSlot.tsx
import { useEffect, useRef } from "react";

/** Mounts an imperative `mount(el) -> cleanup` contribution (a plugin's
 * status bar item or sidebar panel) into a host-managed div. Every plugin
 * contribution uses this same shape, so this is the one place that owns
 * the mount-on-effect / cleanup-on-unmount wiring. */
export function PluginSlot(props: { mount: (el: HTMLElement) => () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cleanup = props.mount(el);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mount]);
  return <div ref={ref} style={{ display: "contents" }} />;
}
```

- [ ] **Step 2: Write the failing loader test**

```ts
// packages/web/src/workbench/plugins/loader.test.ts
import { expect, test } from "bun:test";
import { loadPluginUis } from "./loader";
import { StatusBarRegistry, SidebarPanelRegistry } from "./registries";
import { NotificationHub } from "./notifications";
import type { PluginListEntry, RpcClient } from "@zero/protocol";

function fakeClient(): RpcClient {
  return { request: async () => ({}), notify: () => {}, onNotification: () => {}, onRequest: () => {} } as unknown as RpcClient;
}

function makeEntry(id: string, hasUi: boolean): PluginListEntry {
  return {
    id, name: id, version: "0.0.0",
    health: { ok: true },
    contributions: hasUi ? { ui: { entry: "ui/dist/index.js" } } : {},
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
    importModule: async (url) => ({ mount: () => () => cleanupCalls.push(url) }),
  });
  cleanup();

  expect(cleanupCalls.sort()).toEqual(["/plugins/a/ui.js", "/plugins/b/ui.js"]);
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
    importModule: async () => { calls++; return { mount: () => () => {} }; },
  });

  expect(calls).toBe(0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/web/src/workbench/plugins/loader.test.ts`
Expected: FAIL — `./loader` module does not exist.

- [ ] **Step 4: Implement the loader**

```ts
// packages/web/src/workbench/plugins/loader.ts
import type { PluginListEntry, RpcClient } from "@zero/protocol";
import type { StatusBarItem, StatusBarRegistry, SidebarPanelSpec, SidebarPanelRegistry } from "./registries";
import type { NotificationHub } from "./notifications";

export interface ZeroUiPluginApi {
  client: RpcClient;
  registerStatusBarItem(item: StatusBarItem): void;
  registerSidebarPanel(panel: SidebarPanelSpec): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

export interface PluginUiModule {
  mount(container: HTMLElement, api: ZeroUiPluginApi): () => void;
}

/** Discovers every plugin whose manifest declares a `ui` contribution,
 * dynamically imports its bundle, and calls its `mount`. A failure in any
 * one plugin (bad import, throwing mount) is caught and logged - it never
 * blocks another plugin's UI or the rest of the workbench, mirroring
 * PluginHost.activateBuiltins's per-plugin isolation on the daemon side. */
export async function loadPluginUis(opts: {
  client: RpcClient;
  plugins: PluginListEntry[];
  statusBarRegistry: StatusBarRegistry;
  sidebarPanelRegistry: SidebarPanelRegistry;
  hub: NotificationHub;
  importModule?: (url: string) => Promise<PluginUiModule>;
}): Promise<() => void> {
  const importModule = opts.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const cleanups: Array<() => void> = [];

  await Promise.all(
    opts.plugins
      .filter((p) => p.contributions.ui && p.health.ok)
      .map(async (p) => {
        const url = `/plugins/${p.id}/ui.js`;
        try {
          const mod = await importModule(url);
          const api: ZeroUiPluginApi = {
            client: opts.client,
            registerStatusBarItem: (item) => opts.statusBarRegistry.register(item),
            registerSidebarPanel: (panel) => opts.sidebarPanelRegistry.register(panel),
            onNotification: (method, handler) => opts.hub.subscribe(method, handler),
          };
          const container = document.createElement("div");
          const cleanup = mod.mount(container, api);
          cleanups.push(cleanup);
        } catch (e) {
          console.error(`plugin UI "${p.id}" failed to load:`, e);
        }
      }),
  );

  return () => cleanups.forEach((c) => c());
}
```

Note: `mod.mount(container, api)` here is called with a throwaway `container` div — this top-level `mount` is where a plugin does its one-time setup (typically calling `api.registerStatusBarItem`/`registerSidebarPanel`, which is what actually gets rendered into the real DOM later via `PluginSlot`). The `container` argument exists for symmetry with the per-slot `mount(el)` shape and plugins that want to do work without registering a visible slot at all (e.g. a plugin that only listens to notifications); Tasks 9 and 10's `git`/`todos` plugin UIs don't use it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/web/src/workbench/plugins/loader.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/plugins/PluginSlot.tsx packages/web/src/workbench/plugins/loader.ts packages/web/src/workbench/plugins/loader.test.ts
git commit -m "feat(web): add plugin UI loader, PluginSlot, and ZeroUiPluginApi"
```

---

### Task 7: Web — wire the loader and registries into `Workbench.tsx`

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`

**Interfaces:**
- Consumes: `loadPluginUis` (Task 6), `StatusBarRegistry`/`SidebarPanelRegistry` (Task 5), `NotificationHub` (Task 4), `PluginListResult` (`@zero/protocol`).
- Produces: `WorkbenchContextValue.sidebarView` widened from `"files" | "search"` to `string`; `WorkbenchContextValue.sidebarPanelRegistry: SidebarPanelRegistry` (new field, consumed by `SidebarPanel`).

- [ ] **Step 1: Widen `sidebarView` and add the registry to context**

In `packages/web/src/workbench/layout/Workbench.tsx`, change line 108:

```ts
  sidebarView: "files" | "search";
```
to:
```ts
  sidebarView: string;
```

and add a new field to `WorkbenchContextValue` (near it):

```ts
  sidebarPanelRegistry: SidebarPanelRegistry;
```

Change the `useState` at line 386:

```ts
  const [sidebarView, setSidebarView] = useState<"files" | "search">("files");
```
to:
```ts
  const [sidebarView, setSidebarView] = useState<string>("files");
```

Add imports at the top of the file (alongside the existing `CommandRegistry` import at line 11):

```ts
import { StatusBarRegistry, SidebarPanelRegistry } from "../plugins/registries";
import { NotificationHub } from "../plugins/notifications";
import { loadPluginUis } from "../plugins/loader";
import { PluginSlot } from "../plugins/PluginSlot";
import type { PluginListResult } from "@zero/protocol";
```

(Add `PluginListResult` to the existing multi-import from `@zero/protocol` at line 4 instead, if preferred — either compiles the same; keeping it separate here for a smaller diff against a long existing import line.)

Add the two new `useConst` instances alongside `registry` (line 378):

```ts
  const statusBarRegistry = useConst(() => new StatusBarRegistry());
  const sidebarPanelRegistry = useConst(() => new SidebarPanelRegistry());
  const notificationHub = useConst(() => new NotificationHub());
```

- [ ] **Step 2: Update `SidebarPanel`'s toggle + body**

Replace the `SidebarPanel` function (lines 154-179):

```tsx
function SidebarPanel() {
  const w = useWorkbench();
  const pluginPanels = w.sidebarPanelRegistry.list();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-sidebar-bg)", color: "var(--zero-sidebar-fg)" }}>
      <div className="zero-sidebar-toggle">
        <button aria-pressed={w.sidebarView === "files"} onClick={() => w.setSidebarView("files")}><FilesTabIcon />Files</button>
        <button aria-pressed={w.sidebarView === "search"} onClick={() => w.setSidebarView("search")}><SearchTabIcon />Search</button>
        {pluginPanels.map((p) => (
          <button key={p.id} aria-pressed={w.sidebarView === p.id} onClick={() => w.setSidebarView(p.id)}>{p.title}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {w.sidebarView === "files" ? (
          <FileTreePanel
            ref={w.fileTreeActionsRef}
            client={w.client}
            activePath={w.activePath}
            onOpen={w.openFile}
            refreshToken={w.treeRefreshToken}
            onTreeChanged={w.onTreeChanged}
            onError={w.report}
          />
        ) : w.sidebarView === "search" ? (
          <SearchPanel client={w.client} onJumpTo={(path) => w.openFile(path)} />
        ) : (
          (() => {
            const panel = w.sidebarPanelRegistry.get(w.sidebarView);
            return panel ? <PluginSlot mount={panel.mount} /> : null;
          })()
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Fetch `plugin/list` and load plugin UIs once capabilities/client are ready**

Add a new `useEffect` near the other startup effects (e.g. right after the settings-hydration effect around line 592-602):

```ts
  // Discover daemon plugins with a UI contribution and load their bundles.
  // A plugin without a `ui` contribution, or one that's disabled (health
  // reports "disabled" - see the git/todos plugins), is skipped by
  // loadPluginUis itself; a failure loading one plugin's bundle never
  // blocks another's or the rest of the workbench.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void client
      .request<PluginListResult>("plugin/list")
      .then((res) => {
        if (cancelled) return;
        return loadPluginUis({
          client,
          plugins: res.plugins,
          statusBarRegistry,
          sidebarPanelRegistry,
          hub: notificationHub,
        });
      })
      .then((c) => {
        if (cancelled) c?.();
        else cleanup = c;
      })
      .catch((e: unknown) => console.error("failed to load plugin UIs:", e));
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [client, statusBarRegistry, sidebarPanelRegistry, notificationHub]);
```

- [ ] **Step 4: Route the existing notification handler through the hub**

Replace the `client.onNotification(...)` effect (lines 604-660) — keep the exact same if-chain body, only change how it's registered, and add the hub's own dispatch registration:

```tsx
  // Fans every daemon notification out through notificationHub, so plugin
  // UIs (via ZeroUiPluginApi.onNotification) and this handler share the one
  // slot RpcClient.onNotification allows.
  useEffect(() => {
    client.onNotification((method, params) => notificationHub.dispatch(method, params));
  }, [client, notificationHub]);

  useEffect(() => {
    const handler = (method: string, params: unknown) => {
      if (method === "pty/output") {
        const { sessionId, data } = params as PtyOutputEvent;
        ptyStore.handleOutput(sessionId, data);
        return;
      }
      if (method === "pty/exit") {
        const { sessionId } = params as PtyExitEvent;
        ptyStore.handleExit(sessionId);
        return;
      }
      if (method === "chat/turnEvent") {
        const { turnId, event } = params as ChatTurnEventPayload;
        turnStore.handleEvent(turnId, event);
        return;
      }
      if (method === "lsp/diagnostics") {
        const { path, diagnostics } = params as LspDiagnosticsEvent;
        setDiagnosticsByPath((prev) => {
          const next = new Map(prev);
          next.set(path, diagnostics);
          return next;
        });
        return;
      }
      if (method !== "fs/changed") return;
      const { path } = params as FsChangedEvent;
      clearTimeout(treeDebounceRef.current);
      treeDebounceRef.current = setTimeout(bumpTreeRefreshToken, TREE_REFRESH_DEBOUNCE_MS);

      const lastWrite = lastWriteRef.current;
      if (lastWrite && lastWrite.path === path) {
        lastWriteRef.current = null;
        return;
      }

      const tab = tabStore.getGroups().flatMap((g) => g.tabs).find((t) => t.path === path);
      if (!tab || tab.dirty) return;
      void client
        .request<FsReadResult>("fs/read", { path })
        .then((res) => {
          const current = tabStore.findTab(tab.id);
          if (!current || current.tab.dirty) return;
          tabStore.updateContent(tab.id, res.content);
          tabStore.markSaved(tab.id);
        })
        .catch((e: unknown) => reportRef.current(`Could not reload ${path}: ${errorText(e)}`));
    };
    const methods = ["pty/output", "pty/exit", "chat/turnEvent", "lsp/diagnostics", "fs/changed"];
    const unsubs = methods.map((m) => notificationHub.subscribe(m, (params) => handler(m, params)));
    return () => unsubs.forEach((u) => u());
  }, [client, tabStore, ptyStore, turnStore, notificationHub]);
```

- [ ] **Step 5: Add the new context fields to the `contextValue` object**

Find where `contextValue` (or equivalent object passed to `WorkbenchContext.Provider`) is assembled (around line 1080, where `sidebarView` is listed). Add `sidebarPanelRegistry` next to it:

```ts
    sidebarView,
    sidebarPanelRegistry,
```

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: no new errors beyond the 5 pre-existing ones.

- [ ] **Step 7: Run the web test suite**

Run: `bun test packages/web`
Expected: all existing tests continue to pass (the `sidebarView` type widening from a literal union to `string` should not break any test that compares it to `"files"`/`"search"` string literals — those comparisons still typecheck since `string` is a supertype).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): wire plugin UI loader, registries, and NotificationHub into Workbench"
```

---

### Task 8: Web — render plugin status bar items in `StatusBar.tsx`

**Files:**
- Modify: `packages/web/src/workbench/StatusBar.tsx`
- Modify: `packages/web/src/workbench/layout/Workbench.tsx` (pass the registry down)

**Interfaces:**
- Consumes: `StatusBarRegistry` (Task 5), `PluginSlot` (Task 6).
- Produces: `StatusBar`'s props gain `statusBarItems: StatusBarItem[]`.

- [ ] **Step 1: Add the prop and render it**

In `packages/web/src/workbench/StatusBar.tsx`, add to the props type (after `tokenStatus`, before the closing `}`):

```ts
  /** Status bar items contributed by daemon plugins with a `ui` contribution
   * (e.g. the git plugin). Rendered after the built-in items. */
  statusBarItems?: StatusBarItem[];
```

Add the import at the top:

```ts
import type { StatusBarItem } from "./plugins/registries";
import { PluginSlot } from "./plugins/PluginSlot";
```

Render them right before `<StatusPill engine={props.engine} />` (currently line 106):

```tsx
        {props.statusBarItems?.map((item) => (
          <PluginSlot key={item.id} mount={item.mount} />
        ))}
        <StatusPill engine={props.engine} />
```

- [ ] **Step 2: Pass the registry's list from `Workbench.tsx`**

Find where `<StatusBar ... />` is rendered in `Workbench.tsx` (search for `<StatusBar` — it's passed `graphStatus`, `gitStatus`, `tokenStatus` etc. as props). Add:

```tsx
        statusBarItems={statusBarRegistry.list()}
```

Since `StatusBarRegistry` doesn't itself trigger a re-render when `register`/`unregister` is called (it's a plain class, not React state), and plugin UIs register during the one-time `loadPluginUis` effect from Task 7 which runs once on mount, this static `.list()` read on every `Workbench` render is sufficient for the two plugins this plan ships (they register once, synchronously, during their `mount()` call, before that effect's promise resolves) — no additional re-render plumbing is needed. Note this constraint in a comment above the prop:

```tsx
        // statusBarRegistry doesn't trigger re-renders on register/unregister;
        // plugin UIs register synchronously inside their one-time mount() call
        // (see loadPluginUis in Task 7's effect), so this static read is safe.
        statusBarItems={statusBarRegistry.list()}
```

- [ ] **Step 3: Run typecheck and the web test suite**

Run: `bun run typecheck && bun test packages/web`
Expected: no new errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/workbench/StatusBar.tsx packages/web/src/workbench/layout/Workbench.tsx
git commit -m "feat(web): render plugin-contributed status bar items"
```

---

### Task 9: `git` plugin UI — status bar file-count item

**Files:**
- Create: `packages/daemon/src/testSupport/domTestSetup.ts`
- Modify: `packages/daemon/package.json` (add `jsdom` devDependency)
- Create: `packages/daemon/src/plugins/git/ui/src/index.tsx`
- Test: `packages/daemon/src/plugins/git/ui/src/index.test.tsx`
- Test: `packages/daemon/src/plugins/git/ui/build.test.ts`
- Modify: `packages/daemon/src/plugins/git/index.ts` (declare the `ui` contribution)

**Interfaces:**
- Consumes: `ZeroUiPluginApi` (Task 6, imported as a type-only import from `@zero/protocol`-adjacent web package — see note below on how the daemon package references it).
- Produces: `mount(container, api): () => void`, the plugin's UI entry point, matching `PluginUiModule` from Task 6.

**Note on cross-package types:** `ZeroUiPluginApi` lives in `packages/web/src/workbench/plugins/loader.ts`, and `@zero/daemon` has no dependency on `@zero/web`. Rather than adding a package dependency for a type-only import (which would be backwards — the daemon doesn't depend on the web client), this plugin's `ui/src/index.tsx` declares its own minimal local interface matching the shape it needs. This is intentional: the plugin UI bundle is standalone JS shipped to the browser, not daemon runtime code, so it has no real coupling to `@zero/web`'s internals beyond the `mount(container, api)` contract documented in the spec.

**Note on DOM in tests:** `bun:test` runs under Bun's own runtime, which has no browser DOM (`document` is undefined) — `packages/daemon`'s tests never needed one before this (the CLI's `App.test.tsx` renders through `ink-testing-library`, a terminal renderer, not real DOM). `packages/web` already solved this exact problem for its own React-in-`bun:test` cases with a `jsdom`-backed `packages/web/src/testUtils/domTestSetup.ts`, imported for its side effect before the component under test. This step ports that same pattern into `packages/daemon`, since `@zero/daemon` has no dependency on `@zero/web` to reuse its copy.

- [ ] **Step 1: Add a DOM shim for daemon tests**

Add `jsdom` and `@types/jsdom` to `packages/daemon/package.json`'s `devDependencies` (same versions as `packages/web/package.json`: `"jsdom": "^30.0.1"`, `"@types/jsdom": "^30.0.0"`), then run `bun install`.

Create `packages/daemon/src/testSupport/domTestSetup.ts`, identical in structure to `packages/web/src/testUtils/domTestSetup.ts` (register a `jsdom` `window`/`document`/etc. onto `globalThis` the first time it's imported, guarded by `typeof window === "undefined"`):

```ts
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
```

- [ ] **Step 2: Write the failing UI test**

```tsx
// packages/daemon/src/plugins/git/ui/src/index.test.tsx
import "../../../../testSupport/domTestSetup";
import { describe, expect, test } from "bun:test";
import { mount } from "./index";

function fakeApi(overrides: Partial<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}> = {}) {
  const registered: { id: string; mount: (el: HTMLElement) => () => void }[] = [];
  return {
    api: {
      client: { request: overrides.request ?? (async () => ({})) },
      registerStatusBarItem: (item: { id: string; mount: (el: HTMLElement) => () => void }) => registered.push(item),
      registerSidebarPanel: () => {},
      onNotification: () => () => {},
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
      request: async (method) => {
        if (method === "git/status") {
          return { status: { branch: "main", dirtyCount: 2, ahead: 0, behind: 0, remoteUrl: null, files: [{ path: "a.ts", status: "modified" }, { path: "b.ts", status: "untracked" }] } };
        }
        return {};
      },
    });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    const cleanup = registered[0]!.mount(el);
    // The item's own mount() does an async fetch before rendering; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(el.textContent).toContain("main");
    expect(el.textContent).toContain("2");
    cleanup();
  });

  test("shows nothing when git/status returns a null status (not a git repo)", async () => {
    const { api, registered } = fakeApi({ request: async () => ({ status: null }) });
    mount(document.createElement("div"), api);
    const el = document.createElement("div");
    const cleanup = registered[0]!.mount(el);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.textContent).toBe("");
    cleanup();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/daemon/src/plugins/git/ui/src/index.test.tsx`
Expected: FAIL — `./index` module does not exist.

- [ ] **Step 4: Implement**

```tsx
// packages/daemon/src/plugins/git/ui/src/index.tsx
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";

/** Minimal local shape of ZeroUiPluginApi (packages/web/src/workbench/plugins/loader.ts) -
 * this bundle is standalone browser JS with no dependency on @zero/web, so
 * the contract is restated here rather than imported. */
interface ZeroUiPluginApi {
  client: { request<R>(method: string, params?: unknown): Promise<R> };
  registerStatusBarItem(item: { id: string; mount(el: HTMLElement): () => void }): void;
  registerSidebarPanel(panel: { id: string; title: string; icon?: string; mount(el: HTMLElement): () => void }): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

interface GitStatusFile { path: string; status: string }
interface GitStatusResult {
  branch: string; dirtyCount: number; ahead: number; behind: number;
  remoteUrl: string | null; files: GitStatusFile[];
}

function GitStatusBarItem(props: { client: ZeroUiPluginApi["client"] }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { status } = await props.client.request<{ status: GitStatusResult | null }>("git/status");
        if (!cancelled) setStatus(status);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.client]);

  if (!status) return null;

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", font: "inherit" }}
        title={`${status.files.length} changed file(s)`}
      >
        {status.branch} ({status.files.length})
      </button>
      {open && status.files.length > 0 && (
        <div style={{
          position: "absolute", bottom: "100%", right: 0, marginBottom: 4,
          background: "var(--zero-sidebar-bg, #222)", color: "var(--zero-sidebar-fg, #eee)",
          border: "1px solid var(--zero-border, #444)", borderRadius: 4, padding: 6,
          minWidth: 180, fontSize: 12, zIndex: 10,
        }}>
          {status.files.map((f) => (
            <div key={f.path} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0" }}>
              <span>{f.path}</span>
              <span style={{ opacity: 0.7 }}>{f.status}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

export function mount(_container: HTMLElement, api: ZeroUiPluginApi): () => void {
  api.registerStatusBarItem({
    id: "git",
    mount(el: HTMLElement) {
      const root: Root = createRoot(el);
      root.render(<GitStatusBarItem client={api.client} />);
      return () => root.unmount();
    },
  });
  return () => {};
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/daemon/src/plugins/git/ui/src/index.test.tsx`
Expected: PASS, 3/3.

- [ ] **Step 6: Declare the `ui` contribution on the git plugin's manifest**

In `packages/daemon/src/plugins/git/index.ts`, find the `manifest` object (has `contributions: { rpcMethods: ["git/status", "git/blame"] }`) and add:

```ts
        contributions: { rpcMethods: ["git/status", "git/blame"], ui: { entry: "ui/dist/index.js" } },
```

- [ ] **Step 7: Write an automated `Bun.build()` smoke test**

```ts
// packages/daemon/src/plugins/git/ui/build.test.ts
import { expect, test } from "bun:test";

test("git plugin UI bundles without error and exports mount", async () => {
  const entryPoint = new URL("./src/index.tsx", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [entryPoint],
    target: "browser",
    format: "esm",
  });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  expect(output).toContain("function mount");
});
```

Run: `bun test packages/daemon/src/plugins/git/ui/build.test.ts`
Expected: PASS. This is the automated equivalent of running `build:plugin-ui` manually — it runs as part of `bun test packages/daemon` in CI, so a future change that breaks the bundle (a bad import, a syntax error) fails the test suite rather than only showing up when someone happens to run the build script by hand.

- [ ] **Step 8: Build the bundle for real (for local manual verification) and run the full daemon test suite**

Run: `cd packages/daemon && bun run build:plugin-ui`
Expected: prints `built git/ui/dist/index.js` and `1 plugin UI bundle(s) built`.

Run: `bun test packages/daemon`
Expected: same pass count as before plus the 4 new tests (3 UI behavior + 1 build smoke test); no new failures.

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src/testSupport/domTestSetup.ts packages/daemon/package.json packages/daemon/src/plugins/git/ui packages/daemon/src/plugins/git/index.ts
git commit -m "feat(daemon): add git plugin status bar UI (branch + changed-file count)"
```

Note: `ui/dist/index.js` is a build artifact. Check whether `packages/daemon/.gitignore` (or the root `.gitignore`) already excludes `dist/` directories — if `git status` after this commit shows `ui/dist/index.js` as untracked-and-ignored, that's correct (the daemon rebuilds it via `build:plugin-ui` as part of the release/build process, same as `web-dist`); if it's untracked-and-NOT-ignored, add `packages/daemon/src/plugins/*/ui/dist/` to the root `.gitignore` before committing, so generated bundles don't get committed alongside source.

---

### Task 10: `todos` plugin UI — sidebar panel

**Files:**
- Create: `packages/daemon/src/plugins/todos/ui/src/index.tsx`
- Test: `packages/daemon/src/plugins/todos/ui/src/index.test.tsx`
- Test: `packages/daemon/src/plugins/todos/ui/build.test.ts`
- Modify: `packages/daemon/src/plugins/todos/index.ts` (declare the `ui` contribution)

**Interfaces:**
- Consumes: same local `ZeroUiPluginApi` shape as Task 9 (restated locally, same rationale).
- Produces: `mount(container, api): () => void`.

`jsdom`/`domTestSetup.ts` from Task 9 already covers `packages/daemon`'s DOM-in-tests need — this task reuses it, no new dependency.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/daemon/src/plugins/todos/ui/src/index.test.tsx
import "../../../../testSupport/domTestSetup";
import { describe, expect, test } from "bun:test";
import { mount } from "./index";

function fakeApi(overrides: Partial<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}> = {}) {
  const registered: { id: string; title: string; mount: (el: HTMLElement) => () => void }[] = [];
  const notifHandlers = new Map<string, (params: unknown) => void>();
  return {
    api: {
      client: { request: overrides.request ?? (async () => ({})) },
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
    const cleanup = registered[0]!.mount(el);
    await new Promise((r) => setTimeout(r, 0));
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
    const cleanup = registered[0]!.mount(el);
    await new Promise((r) => setTimeout(r, 0));
    expect(listCalls).toBe(1);

    notifHandlers.get("fs/changed")?.({ path: "a.ts" });
    await new Promise((r) => setTimeout(r, 0));
    expect(listCalls).toBe(2);
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/daemon/src/plugins/todos/ui/src/index.test.tsx`
Expected: FAIL — `./index` module does not exist.

- [ ] **Step 3: Implement**

```tsx
// packages/daemon/src/plugins/todos/ui/src/index.tsx
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState } from "react";

interface ZeroUiPluginApi {
  client: { request<R>(method: string, params?: unknown): Promise<R> };
  registerStatusBarItem(item: { id: string; mount(el: HTMLElement): () => void }): void;
  registerSidebarPanel(panel: { id: string; title: string; icon?: string; mount(el: HTMLElement): () => void }): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}

interface TodoEntry { path: string; line: number; kind: "TODO" | "FIXME" | "HACK"; text: string }

function TodosPanel(props: { client: ZeroUiPluginApi["client"]; onNotification: ZeroUiPluginApi["onNotification"] }) {
  const [entries, setEntries] = useState<TodoEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const { entries } = await props.client.request<{ entries: TodoEntry[] }>("todos/list");
        if (!cancelled) setEntries(entries);
      } catch {
        if (!cancelled) setEntries([]);
      }
    };
    void refresh();
    const unsubscribe = props.onNotification("fs/changed", () => void refresh());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [props.client, props.onNotification]);

  if (entries.length === 0) {
    return <div style={{ padding: 12, opacity: 0.7, fontSize: 13 }}>No TODOs found.</div>;
  }

  return (
    <div style={{ overflowY: "auto", height: "100%", fontSize: 13 }}>
      {entries.map((e) => (
        <div key={`${e.path}:${e.line}`} style={{ padding: "6px 12px", borderBottom: "1px solid var(--zero-border, #333)" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <span style={{ fontWeight: 600, opacity: 0.8 }}>{e.kind}</span>
            <span style={{ opacity: 0.6 }}>{e.path}:{e.line}</span>
          </div>
          <div>{e.text}</div>
        </div>
      ))}
    </div>
  );
}

export function mount(_container: HTMLElement, api: ZeroUiPluginApi): () => void {
  api.registerSidebarPanel({
    id: "todos",
    title: "TODOs",
    mount(el: HTMLElement) {
      const root: Root = createRoot(el);
      root.render(<TodosPanel client={api.client} onNotification={api.onNotification} />);
      return () => root.unmount();
    },
  });
  return () => {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/daemon/src/plugins/todos/ui/src/index.test.tsx`
Expected: PASS, 3/3.

- [ ] **Step 5: Declare the `ui` contribution on the todos plugin's manifest**

In `packages/daemon/src/plugins/todos/index.ts`, find the `manifest` object (has `contributions: { rpcMethods: ["todos/list", "todos/at"] }`) and add:

```ts
        contributions: { rpcMethods: ["todos/list", "todos/at"], ui: { entry: "ui/dist/index.js" } },
```

- [ ] **Step 6: Write an automated `Bun.build()` smoke test**

```ts
// packages/daemon/src/plugins/todos/ui/build.test.ts
import { expect, test } from "bun:test";

test("todos plugin UI bundles without error and exports mount", async () => {
  const entryPoint = new URL("./src/index.tsx", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [entryPoint],
    target: "browser",
    format: "esm",
  });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  expect(output).toContain("function mount");
});
```

Run: `bun test packages/daemon/src/plugins/todos/ui/build.test.ts`
Expected: PASS.

- [ ] **Step 7: Build the bundle for real and run the full daemon test suite**

Run: `cd packages/daemon && bun run build:plugin-ui`
Expected: prints `built git/ui/dist/index.js`, `built todos/ui/dist/index.js`, `2 plugin UI bundle(s) built`.

Run: `bun test packages/daemon`
Expected: same pass count as before plus the 4 new tests (3 UI behavior + 1 build smoke test); no new failures.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/src/plugins/todos/ui packages/daemon/src/plugins/todos/index.ts
git commit -m "feat(daemon): add todos plugin sidebar panel UI"
```

---

### Task 11: Remove the now-redundant hardcoded git status bar polling

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`
- Modify: `packages/web/src/workbench/StatusBar.tsx`

**Rationale:** `Workbench.tsx` still has a pre-existing hardcoded `git/status` poll (the `gitStatus` state and its `useEffect`, lines ~411-417 and ~505-534) feeding a `gitStatus` prop into `StatusBar.tsx` (lines 32-34, 88-100), which shows the same branch name the new git plugin UI's status bar item now also shows. Keeping both would show the branch twice. The plugin's item additionally shows the changed-file list on click, which the old pill didn't have, so it's a strict upgrade — remove the old one.

- [ ] **Step 1: Remove the `gitStatus` state and its polling effect from `Workbench.tsx`**

Delete the `gitStatus` `useState` block (currently lines 411-417):

```ts
  const [gitStatus, setGitStatus] = useState<{
    branch: string;
    dirtyCount: number;
    ahead: number;
    behind: number;
    remoteUrl: string | null;
  } | null>(null);
```

Delete the git status polling `useEffect` (currently lines 505-534, the one with the comment starting "Poll git branch/dirty/remote status for the status bar").

Remove the `gitStatus={gitStatus}` prop from wherever `<StatusBar ... />` is rendered.

- [ ] **Step 2: Remove the `gitStatus` prop and rendering from `StatusBar.tsx`**

Delete the `gitStatus` prop from the props type (lines 32-34) and its rendering block (lines 88-100, the `{props.gitStatus && (...)}` block). Also remove the now-unused `toHttpsUrl` helper (lines 12-18) and its only caller — check with `grep -n "toHttpsUrl" packages/web/src/workbench/StatusBar.tsx` first in case it's still referenced elsewhere in the file after the edit; if the grep shows only the definition, delete it.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: no new errors — if any test file still passes a `gitStatus` prop to `<StatusBar />`, TypeScript's excess-property checking on object literals will NOT catch it automatically for a removed prop (removing a prop from the type just makes passing it a `strict`-mode error only if the prop is passed inline as an object literal against a now-narrower type; since it's simply no longer part of the interface, an old test passing `gitStatus={...}` will fail to typecheck as an unknown prop). Fix any such call sites by deleting the `gitStatus` line from the test's props.

- [ ] **Step 4: Run the web test suite**

Run: `bun test packages/web`
Expected: all tests pass. If a `StatusBar.test.tsx` test specifically asserted on the old branch-pill rendering, update or remove that assertion (the branch is no longer rendered by `StatusBar` itself — it's now inside the git plugin's `PluginSlot`-rendered item, which that plugin's own `index.test.tsx` from Task 9 already covers).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/layout/Workbench.tsx packages/web/src/workbench/StatusBar.tsx
git commit -m "refactor(web): remove hardcoded git status pill, superseded by the git plugin's status bar item"
```

---

### Task 12: End-to-end manual verification

**Files:** none (verification only, no code changes).

- [ ] **Step 1: Build everything**

Run:
```bash
cd packages/daemon && bun run build:plugin-ui
cd ../web && bun run build
```
Expected: both succeed with no errors.

- [ ] **Step 2: Start the daemon against this repo itself as the workspace**

Use the `run` skill (per this project's convention for verifying UI changes in a real browser) to launch `zero serve` against a scratch git repo containing at least one `// TODO: ...` comment and one uncommitted file change, then open the served UI in a browser.

- [ ] **Step 3: Verify in-browser**

Check:
- The status bar shows a `branch (N)` button from the git plugin; clicking it opens a dropdown listing the changed files.
- The sidebar toggle row shows a third "TODOs" button alongside Files/Search; clicking it lists the `// TODO`/`// FIXME`/`// HACK` comments from the scratch repo, each showing path:line and text.
- Editing a file to add a new `// TODO` and saving updates the TODOs panel without a manual refresh (verifies the `fs/changed` → `onNotification` → re-fetch path).
- Toggling between Files/Search/TODOs and back doesn't lose file-tree or search state (verifies `PluginSlot`'s mount/unmount doesn't interfere with the existing panels).
- No console errors related to `plugin/list`, `/plugins/*/ui.js`, or React "invalid hook call" warnings (confirms the self-contained-bundle approach avoids the shared-React-instance failure mode the spec calls out).

- [ ] **Step 4: Report results**

No commit for this task — it's verification. If any check fails, return to the relevant task above and fix before considering the plan complete.
