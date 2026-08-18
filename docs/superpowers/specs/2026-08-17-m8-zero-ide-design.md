# M8: Zero IDE (Core Wrap)

Status: Approved

## 1. Scope

M8's roadmap line (`docs/superpowers/specs/2026-08-04-zero-design.md`,
section 13) bundles three things: "Tauri wrap with bundled daemon (Bun
compile), auto-update, native menus." This spec covers the first slice
only: a Tauri desktop shell that bundles the daemon as a standalone
sidecar binary, opens a native window pointed at it, and lets the user
pick a workspace folder. Auto-update and native menus are explicitly
deferred to follow-on specs once this core wrap is proven.

### In scope

- New `packages/desktop` (`zero-desktop`), a Tauri v2 project.
- `bun build --compile` sidecar build for `@zero/daemon`, including
  bundling a portable `node` binary plus the `node-pty` package
  directory as sidecar resources so the terminal's real-`node`-hosted
  PTY worker (see section 4.2) runs without relying on anything
  installed on the user's machine.
- Native "Open Folder" dialog on first launch; last-opened folder
  remembered for subsequent launches.
- Sidecar lifecycle: spawn on launch (or on folder selection), wait for
  ready, point the webview at it, kill on window close.
- Manual smoke-test checklist and unit tests for the new path-resolution
  and sidecar-lifecycle logic.

### Out of scope (explicit)

- Auto-update (Tauri updater plugin, release channel, signing).
- Native menus / OS-integration polish (dock icon, menu bar items,
  global shortcuts).
- Multi-window / multi-workspace support - one workspace per app
  instance, matching `zero serve`'s current single-root model.
- Plugin worker isolation and any online/cloud capabilities - both
  explicitly called out in the roadmap as landing later in the M8 era,
  not this slice.
- Windows/Linux packaging polish - build for the current dev platform
  (macOS) first; cross-platform sidecar builds are a follow-up once the
  approach is validated.

## 2. Decisions (from design session)

| Decision | Choice |
|---|---|
| Daemon distribution | `bun build --compile` sidecar binary, bundled into the Tauri app - no assumed Bun/Node on the user's machine |
| UI loading | Webview navigates to the daemon's own `http://127.0.0.1:<port>/?token=<token>` - identical to what `zero serve` prints today, zero new serving logic |
| PTY support | Fixed now: a portable `node` binary + `node-pty` package dir ship as sidecar resources, not deferred |
| Workspace selection | Native "Open Folder" dialog on first launch; remembered for next launch |
| Auto-update / native menus | Deferred to follow-on specs |

## 3. Architecture

```
zero-desktop (Tauri v2 app)
 ├─ Rust shell (src-tauri/)
 │   ├─ on launch: read remembered workspace path (or show Open Folder dialog)
 │   ├─ spawn sidecar: zero-daemon-sidecar serve <path> --port 0 --gateway-port 0
 │   ├─ parse sidecar's ready line (JSON on stdout) for {port, token}
 │   ├─ open/update window, navigate webview to http://127.0.0.1:<port>/?token=<token>
 │   └─ on window close: kill sidecar child process
 └─ bundled resources/
     ├─ zero-daemon-sidecar        (bun build --compile output)
     ├─ node-runtime/
     │   ├─ node                    (portable node binary, copied from the build machine)
     │   ├─ pty-worker.js           (plain-file copy, see 4.2)
     │   └─ node_modules/node-pty/  (full package dir incl. native addon)
     └─ web/dist/                   (packages/web production build, served by the daemon itself)
```

No new JSON-RPC surface, no new HTTP surface. The Tauri shell's only
daemon-facing job is: spawn it with the right arguments, read one line of
structured startup output, and navigate the webview. Everything after
that - editor, terminal, chat, completions - runs exactly as it does
under `zero serve`, because it's the same daemon and the same web
client talking the same protocol.

## 4. Daemon changes (`@zero/daemon`)

### 4.1 Machine-readable ready signal

`zero serve` currently prints a human-oriented line
(`zero ready: http://127.0.0.1:${port}/?token=${token}`) to stdout. The
Tauri shell needs to parse this reliably, so `bin/zero.ts`'s `serve`
branch gains a `--json` flag: when present, it prints *only* the single
JSON line (`{"port":...,"token":...,"gatewayInfo":...}`) instead of the
human-readable line - no other stdout output before or after it, so the
Rust side can read exactly one line and parse it unambiguously. Without
`--json`, behavior is byte-for-byte identical to today. This is the
only CLI-surface change; `startZero`/`createDaemon` are untouched.

### 4.2 PTY under the compiled sidecar: bundling a real `node`

`packages/daemon/src/pty.ts` does not use `node-pty`'s native addon
in-process. It spawns a **separate real `node` process**
(`spawn("node", [workerPath])`) running `pty-worker.js`, because
node-pty's native binding does not deliver events correctly under
Bun's runtime at all (see the comment block at the top of `pty.ts`).
`pty-worker.js` then does `require.resolve("node-pty/package.json")`
against a real `node_modules` tree to locate the native addon.

None of that exists inside (or next to) a `bun build --compile` single
file executable by default, so three things ship as sidecar resources
alongside the compiled daemon binary, and two small hooks let `pty.ts`
find them:

- **Portable `node` binary**: the build script copies the build
  machine's own `node` executable (`$(command -v node)`) into the
  bundle's resources directory as `node-runtime/node`. Scope note:
  this only works because M8's build target is the current dev
  platform (macOS) per section 1's "out of scope" list - a portable,
  correctly-licensed, cross-platform Node distribution is follow-up
  work when Windows/Linux packaging is tackled.
- **`node-pty` package directory**: the build script copies
  `node_modules/node-pty` (whole directory, including its compiled
  native addon under `build/Release/`) into
  `node-runtime/node_modules/node-pty`, so `require.resolve` inside
  `pty-worker.js` finds a real `package.json` to walk from.
- **`pty-worker.js` itself**: copied as a plain file to
  `node-runtime/pty-worker.js` (today it's loaded via
  `fileURLToPath(new URL("./pty-worker.js", import.meta.url))`, which
  does not resolve to a real on-disk path inside a compiled binary).

Runtime hook in `pty.ts`: two new env vars, `ZERO_PTY_NODE_BIN` and
`ZERO_PTY_WORKER_DIR`. When both are set, `PtyService` spawns
`ZERO_PTY_NODE_BIN` with `${ZERO_PTY_WORKER_DIR}/pty-worker.js` and
`cwd: ZERO_PTY_WORKER_DIR` (so `require.resolve` walks up from a
directory that actually has `node_modules/node-pty` in it), instead of
`spawn("node", [fileURLToPath(...)])`. When either is unset - the
normal `zero serve`/`zero claude`/VS Code-daemon dev path - behavior is
byte-for-byte identical to today. The Tauri shell sets both env vars to
its bundled resources subpaths when spawning the sidecar.

This keeps every other daemon consumer (`zero serve`, `zero claude`,
the VS Code extension's daemon spawn) completely unaffected, since none
of them set `ZERO_PTY_NODE_BIN`/`ZERO_PTY_WORKER_DIR`.

### 4.3 Build script

`packages/daemon/scripts/build-sidecar.sh` (new):

```bash
set -euo pipefail
bun build --compile --outfile dist/zero-daemon-sidecar packages/daemon/bin/zero.ts

mkdir -p dist/node-runtime/node_modules
cp "$(command -v node)" dist/node-runtime/node
cp -R node_modules/node-pty dist/node-runtime/node_modules/node-pty
cp src/pty-worker.js dist/node-runtime/pty-worker.js
```

Invoked from `packages/desktop`'s Tauri build hook (`beforeBuildCommand`
in `tauri.conf.json`), so `bun run --cwd packages/desktop tauri build`
produces a fully self-contained app bundle in one command.

## 5. `packages/desktop` layout

```
packages/desktop/
  package.json           # "zero-desktop", tauri dev/build scripts
  src-tauri/
    Cargo.toml
    tauri.conf.json       # window config, bundled resources, beforeBuildCommand
    src/
      main.rs              # app entry
      sidecar.rs           # spawn/monitor/kill the daemon sidecar, parse ready JSON
      workspace.rs          # remembered-workspace read/write, Open Folder dialog
  README.md
```

Remembered workspace path is stored via Tauri's `tauri-plugin-store` (or
a plain JSON file under the OS app-data dir - implementation detail for
the plan) - not `@zero/daemon`'s own `~/.zero` settings store, since
this is a desktop-shell concern, not an engine concern.

## 6. Data flow (first launch)

1. App starts, `src-tauri/src/main.rs` reads remembered workspace -
   none found.
2. Native Open Folder dialog shown; user picks a directory.
3. Path saved to the remembered-workspace store.
4. `sidecar.rs` spawns
   `zero-daemon-sidecar serve <path> --port 0 --gateway-port 0 --json`
   with `ZERO_PTY_NODE_BIN` and `ZERO_PTY_WORKER_DIR` set to the
   bundled `node-runtime/node` binary and `node-runtime/` directory
   respectively.
5. Shell reads stdout until it gets a parseable JSON line; on success,
   opens the main window and navigates to
   `http://127.0.0.1:<port>/?token=<token>`.
6. User works normally (editor/terminal/chat/completions) - identical
   experience to `zero serve` in a browser tab, now in a native window.
7. On window close, the shell sends the sidecar process SIGTERM, waits
   briefly, SIGKILLs if it hasn't exited.

Subsequent launches skip steps 1-3 and use the remembered path
directly. There is no in-app way to switch workspaces in this slice -
that needs either a native menu item or an in-webview affordance, and
both are deferred (menus per section 1's "native menus" exclusion; an
in-webview affordance would be new UI surface this spec doesn't scope).
Until a follow-on spec adds one, switching workspaces means deleting
the remembered-workspace store file by hand (documented in
`packages/desktop/README.md`) and relaunching.

## 7. Error handling

- **Sidecar fails to start / exits before printing ready JSON**: window
  shows a native error dialog with the process's captured stderr tail,
  then the app quits (no "Retry" button in this first cut - the app
  does not silently show a blank, unquittable window, which is the
  property that matters; retry-without-quitting is a follow-up).
- **Port already in use**: not expected in practice since the sidecar is
  asked for port `0` (OS-assigned), but if the sidecar itself reports a
  bind failure, it surfaces through the same stderr-capture path above.
- **Chosen workspace no longer exists** (deleted since last launch):
  detected before spawning the sidecar (`std::path::Path::exists`
  check in Rust); falls back to the Open Folder dialog instead of
  spawning a daemon rooted at a missing path.
- **Bundled `node-runtime/` missing/broken** (e.g. bundle built on a
  different OS/arch than it's run on, or the copy step failed): the
  daemon's existing PTY error path already surfaces spawn failures to
  the terminal UI per-session; no new user-facing surface needed, this
  degrades the same way a missing PTY dependency does under
  `zero serve` today - editor/chat/completions stay fully usable, only
  the terminal panel fails.

## 8. Testing

- **`packages/daemon`**: unit tests for the new
  `ZERO_PTY_NODE_BIN`/`ZERO_PTY_WORKER_DIR`-based spawn override (fake
  env vars pointing at a temp dir with a stub `node` shim and worker
  file; assert `PtyService` spawns that path with that cwd instead of
  the default `spawn("node", [fileURLToPath(...)])`) and for the `--json` ready
  line's shape.
- **`packages/desktop`**: Rust unit tests for the ready-JSON parser
  (`sidecar.rs`) and the remembered-workspace read/write round-trip
  (`workspace.rs`), using `tempfile` for the store location. Sidecar
  spawn/kill lifecycle is integration-tested manually (see below) since
  it depends on a real OS process and window - not worth mocking for a
  first cut.
- **Manual smoke test** (recorded as a checklist in
  `packages/desktop/README.md`, run before considering the milestone
  done): fresh launch shows Open Folder dialog -> pick a folder ->
  window opens showing the editor -> open a file, edit, save -> open
  terminal, run a command -> ask chat a question -> quit app -> relaunch
  -> same folder opens automatically with no dialog.

## 9. Out-of-scope follow-ups (not this milestone)

- Auto-update (Tauri updater plugin + release signing + channel).
- Native menus, dock/menu-bar integration, global shortcuts - including
  an in-app "change workspace" affordance, which needs one of these.
- Cross-platform (Windows/Linux) sidecar builds and packaging.
- Multi-window / multi-workspace-per-instance support.
- Plugin worker isolation, cloud provider auth, sync (explicitly called
  out in the top-level roadmap as landing "in this era" but not required
  for the core wrap).
- ~~`packages/web`'s use of `window.prompt()`/`alert()`/`confirm()`~~ -
  discovered during this milestone's manual smoke test (Tauri's WKWebView
  on macOS doesn't implement the `WKUIDelegate` methods these need, so
  the calls silently returned nothing), and fixed as a same-milestone
  follow-up rather than deferred: `FileTreePanel.tsx`'s New File/New
  Folder/Rename/Delete and `TerminalPanel.tsx`'s tab rename now use
  inline editing instead of `window.prompt()`/`confirm()`. Since this
  lives in `packages/web`, the fix applies to Zero Lite and the
  daemon-served browser workbench too, not just desktop.
- No timeout on `sidecar.rs::wait_for_ready()` - if the daemon spawns
  but hangs before printing its ready line, the app has no window and
  no way to quit but Force Quit. Cmd+Q/Dock-quit teardown (via
  `RunEvent::ExitRequested`) is handled as of this milestone, but this
  particular hang case is not.
- Offline completions inside Zero IDE are limited to the Ollama-compatible
  provider - the Chrome-only Nano API (`window.LanguageModel`) that
  `zero serve`/`zero claude` rely on doesn't exist in WKWebView (Safari's
  engine), which is what Tauri uses on macOS. Not a bug, just a real
  constraint worth documenting.

## 10. M8.5: Zero IDE polish (planned)

Status: Done

Zero's milestone roadmap ends at M8; no further numbered milestones are
planned, and cross-platform packaging and auto-update are explicitly out
of scope going forward (decided after M8 shipped - see section 9's first
and third bullets, which stay deferred indefinitely rather than rolling
into a future milestone). M8.5 picks up the remaining M8 follow-ups that
are still worth doing on the current macOS-only, no-auto-update scope:

- **`sidecar.rs::wait_for_ready()` timeout.** If the daemon process spawns
  but hangs before printing its ready line, Zero IDE opens no window and
  gives the user no way to quit but Force Quit. Add a timeout that kills
  the sidecar and shows the existing failure dialog (same path as a
  sidecar that exits early) instead of hanging forever.
- **Native menus, dock/menu-bar integration, global shortcuts.** Includes
  an in-app "change workspace" affordance - today the only way to switch
  workspace is to delete the remembered-workspace file and relaunch.
  Scope this as: a native "File > Open Folder..." menu item (and/or a
  keyboard shortcut) that re-runs the folder picker and restarts the
  sidecar against the new workspace, without requiring an app restart.
- **Multi-window / multi-workspace-per-instance support.** Open more than
  one workspace at a time, one native window per workspace, instead of
  today's single-workspace-per-app-instance model.

Out of scope for M8.5 (unchanged from M8, now indefinite rather than
"deferred"): auto-update, cross-platform (Windows/Linux) builds, plugin
worker isolation, cloud provider auth, sync. The Ollama-only completions
constraint inside WKWebView is a platform limitation, not a follow-up -
nothing to schedule there.
