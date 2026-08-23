# UI plugin framework

Lets a daemon-side plugin (`ZeroPlugin`) optionally contribute browser UI —
a status bar item, a sidebar panel — that the web workbench loads and mounts
at runtime. First consumers: the `git` and `todos` plugins built earlier.

## Motivation

The `git` and `todos` daemon plugins expose `git/status`, `git/blame`,
`todos/list`, `todos/at` over RPC, but nothing in the workbench surfaces
them. Today every workbench panel (file tree, chat, terminal, search) is a
hardcoded import in `Workbench.tsx` — there is no way for a plugin to add UI
without editing web's source directly. This adds that seam, scoped to
exactly what `git`/`todos` need: one status bar item, one sidebar panel.

Because `packages/desktop` has no UI code of its own — it's a Tauri shell
that loads `@zero/web`'s built output through a bundled daemon sidecar
(`docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md`) — building this
in `@zero/web` covers desktop automatically. `packages/vscode` and the
Claude Code plugin are untouched; neither loads the web workbench.

## Non-goals

- External/third-party plugin discovery (`~/.zero/plugins/`) — daemon-side
  plugins are still built-ins only
  (`docs/superpowers/specs/2026-08-05-m3-graphify-and-plugin-host-design.md`).
  This UI framework serves built-in plugins' UI, the same maturity level.
- Sandboxing (iframes, postMessage). Plugin UI code runs in the main page
  context with full DOM/React access, same trust level as the rest of
  `@zero/web` — these are built-ins shipped in this repo, not arbitrary
  third-party code.
- Editor-area contributions (a plugin adding a new file viewer, a gutter
  decoration, etc.) — only status bar items and sidebar panels, the two
  slots `git`/`todos` need.
- A shared React instance between host and plugin bundles (see "Why each
  plugin bundles its own React" below) — deliberately avoided, not deferred.
- VS Code extension, Claude Code plugin — unaffected.

## Why each plugin bundles its own React

The natural-seeming approach — externalize `react`/`react-dom` from the
plugin build and have it resolve against the host page's copy at runtime
(import maps, a `window.React` global, etc.) — was considered and rejected.
It requires Vite config changes on the host side, a runtime contract the
plugin bundle must match exactly (React version, dev/prod build), and
produces "invalid hook call" failures that are hard to diagnose when it
drifts. None of that machinery is needed if the plugin bundle is fully
self-contained and exposes an **imperative mount point** instead of a React
component the host renders inside its own tree:

```ts
export function mount(container: HTMLElement, api: ZeroUiPluginApi): () => void;
```

The host gives the plugin a `<div>` and calls `mount`/the returned cleanup
function from a `useEffect` — the two React trees (host's, plugin's) never
nest, so there's no shared-instance problem to solve. The cost is a
duplicate ~40kb (gzipped) React copy per plugin UI bundle, which is
negligible against the alternative's coupling and failure modes. This is
the same pattern VS Code webviews and most micro-frontend UIs use.

## Daemon side

### Plugin manifest: `ui` contribution

`PluginManifest.contributions` (`packages/daemon/src/plugins/types.ts`)
gains an optional field:

```ts
contributions: {
  rpcMethods?: string[];
  contextProviders?: string[];
  tools?: string[];
  commands?: string[];
  ui?: { entry: string };   // relative path within the plugin's own dir, e.g. "ui/dist/index.js"
}
```

No `PluginHost` code changes — `plugin/list` already returns
`contributions` verbatim (`packages/daemon/src/plugins/host.ts:79-89`), so
the web client discovers UI-bearing plugins for free.

### Static route: `GET /plugins/:id/ui.js`

`packages/daemon/src/server.ts`'s single manual `fetch` handler (the one
that already serves `opts.webDist`, around line 25) gets one more branch,
checked before the `webDist` fallback:

```ts
if (url.pathname.startsWith("/plugins/") && url.pathname.endsWith("/ui.js")) {
  const id = url.pathname.split("/")[2];
  const entry = pluginUiEntry(id); // looks up contributions.ui.entry from the activated plugin list
  if (!entry) return new Response("not found", { status: 404 });
  const file = Bun.file(join(pluginsDir, id, entry));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "Content-Type": "text/javascript" } });
}
```

`pluginsDir` resolves to `packages/daemon/src/plugins` at runtime (same
directory layout used for `git`/`todos`/`graphify`). Content-Type is set
explicitly — Bun's automatic type inference (used for the `webDist` case)
isn't relied on here since `.js` isn't in the existing small mime table
(`packages/daemon/src/mime.ts`) and being explicit is one line either way.

### Building a plugin's UI bundle

Each UI-contributing plugin gets a `ui/` subfolder:

```
packages/daemon/src/plugins/git/
  index.ts, status.ts, blame.ts, *.test.ts   (existing)
  ui/
    src/index.tsx        # exports mount(container, api)
    dist/index.js         # build output, served at /plugins/git/ui.js
```

Bundling uses Bun's built-in `Bun.build()` — no new dependency; this is
already a Bun-first codebase (`bun test`, `Bun.spawn` used throughout the
git/todos plugins). No `external` list: `react`/`react-dom` are bundled in,
per the design above. `packages/daemon/package.json` gets a
`build:plugin-ui` script that runs `Bun.build()` over each `plugins/*/ui/src/index.tsx`
that exists, emitting to the matching `ui/dist/index.js`. `react` and
`react-dom` become direct dependencies of `@zero/daemon` (dev-time bundling
inputs only — not used anywhere in the daemon's own runtime code).

## Web side

### Loader

New module `packages/web/src/workbench/plugins/loader.ts`. After the
existing `plugin/list` RPC resolves (or a new call to it — the client
already fetches capabilities at startup via `session/hello`;
`plugin/list` is queried alongside it), for each plugin whose
`contributions.ui` is set:

```ts
const mod = await import(/* @vite-ignore */ `/plugins/${plugin.id}/ui.js`);
const cleanup = mod.mount(container, api);
```

Wrapped in try/catch per plugin — a failed `import()` (404, syntax error)
or a throw inside `mount` is logged and skipped; it never blocks the rest
of the workbench or other plugins' UI, mirroring the daemon
`PluginHost.activateBuiltins`'s per-plugin isolation
(`packages/daemon/src/plugins/host.ts:38-68`).

### Plugin UI API

Passed into every `mount(container, api)` call:

```ts
interface ZeroUiPluginApi {
  client: RpcClient;
  registerStatusBarItem(item: { id: string; mount(el: HTMLElement): () => void }): void;
  registerSidebarPanel(panel: { id: string; title: string; icon?: string; mount(el: HTMLElement): () => void }): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
}
```

`registerStatusBarItem`/`registerSidebarPanel` take the same imperative
`mount(el) → cleanup` shape as the top-level plugin entry — consistent all
the way down, and it means a status bar item or sidebar panel is exactly as
simple to implement as the plugin's root export.

### Notification pub/sub

Today `Workbench.tsx` installs exactly one `client.onNotification` handler
for the entire app (`RpcClient.onNotification` is single-slot — a second
call replaces the first) and hand-switches on `method`
(`pty/output`, `fs/changed`, `chat/turnEvent`, `lsp/diagnostics`). This
becomes a small `Map<string, Set<(params: unknown) => void>>` dispatcher:
one `client.onNotification` registration that fans out to all subscribers
of a method. The existing hardcoded cases become the first subscribers
registered against it — no special-casing between built-in features and
plugin subscribers. `onNotification` in `ZeroUiPluginApi` returns an
unsubscribe function, matching `CommandRegistry.unregister`'s convention.

### Registries

`StatusBarRegistry` and `SidebarPanelRegistry`
(`packages/web/src/workbench/plugins/registries.ts`), same shape as
`CommandRegistry` (`packages/web/src/workbench/commands/registry.ts`):
`Map`-backed, `register`/`unregister`/`get`/`list`.

- `StatusBar.tsx` renders `registry.list()` after its existing hardcoded
  items, each via a small `<PluginSlot mount={item.mount} />` wrapper
  (`useRef` + `useEffect` calling `mount(el)` on mount, the returned
  cleanup on unmount).
- `Workbench.tsx`'s `SidebarPanel` (lines 154-179): `sidebarView` widens
  from the literal union `"files" | "search"` to `string` (both the context
  type at line 108 and the `useState` at line 386). The toggle button row
  becomes `["files", "search", ...panelRegistry.list().map(p => p.id)]`,
  and the body's ternary becomes a lookup: built-in ids keep their existing
  components (`FileTreePanel`, `SearchPanel`), any other id renders
  `<PluginSlot mount={panelRegistry.get(id).mount} />`.

### First two plugins using it

- **git**: `ui/src/index.tsx` calls `api.registerStatusBarItem` with a
  `⎇ <branch> (<dirtyCount>)` label built from polling `git/status` (same
  2-second interval pattern already in `Workbench.tsx:474-499`, now owned
  by the plugin instead of the host). Click opens a small dropdown listing
  `status.files`. No sidebar panel.
- **todos**: `ui/src/index.tsx` calls `api.registerSidebarPanel` with a
  panel listing `todos/list` entries (path, line, kind, text), refreshed
  via `api.onNotification("fs/changed", ...)` rather than polling. Clicking
  an entry opens the file at that line, reusing the existing "open file at
  position" behavior already wired into the editor for other jump-to-line
  callers.

Both plugins call `client.request` directly against RPCs the daemon side
already registers (`git/status`, `todos/list`) — no new protocol messages
needed for this layer itself.

## Error handling

- Missing/failed plugin UI bundle: loader catches, logs, skips — workbench
  degrades to no extra status bar item / sidebar panel for that plugin,
  never a broken app (matches the project's "degrade the failing subsystem
  only" rule in `CLAUDE.md`).
- `git.enabled` / `todos.enabled` set to `false`: the daemon plugin's
  `manifest.contributions` still reports `ui`, but `plugin/health()` for a
  disabled plugin already returns `{ ok: true, detail: "disabled" }`
  (built in the earlier `git`/`todos` work) — the loader additionally
  skips loading UI for any plugin whose health is `disabled`, so a
  disabled plugin's status bar item / panel never appears.

## Testing

- **Daemon**: unit test for the new `/plugins/:id/ui.js` route in
  `server.test.ts` (200 + correct content-type for an existing bundle, 404
  for an unknown plugin id or missing dist file). A `Bun.build()` smoke
  test asserting `git/ui/src/index.tsx` and `todos/ui/src/index.tsx` each
  bundle without error and export `mount`.
- **Web**: unit tests for `StatusBarRegistry`/`SidebarPanelRegistry`
  (register/unregister/list), mirroring whatever test conventions
  `commands/registry.ts` already has. A loader test using a fake
  `import()` (injected function, not the real dynamic import) verifying
  one plugin throwing during `mount` doesn't prevent a second plugin's UI
  from loading.
- **Manual**: no new E2E harness — verify in-browser via the `run` skill
  that a built git/todos UI bundle actually round-trips through the real
  dynamic `import()` and mounts/unmounts cleanly on panel toggle, since
  that path (Vite dev server ↔ daemon-served `/plugins/*/ui.js` ↔ browser
  module loader) isn't meaningfully exercised by unit tests with a faked
  `import()`.
