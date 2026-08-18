# Zero IDE (`zero-desktop`)

Tauri v2 desktop wrap around Zero: bundles `@zero/daemon` as a standalone
`bun build --compile` sidecar (with a portable node runtime for the
terminal) and opens the same web client in a native window. See
[`docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md`](../../docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md)
for the full design.

## Development

```
bun run --cwd packages/web build              # builds the web UI the sidecar serves
bun run --cwd packages/daemon build:sidecar   # compiles the daemon sidecar + bundles node-runtime/web-dist
bun run --cwd packages/desktop tauri dev      # launches the app
```

`tauri build` produces a release bundle under
`packages/desktop/src-tauri/target/release/bundle/`; its
`beforeBuildCommand` builds `packages/web` and the sidecar automatically.

## Switching workspaces

There's no in-app "change workspace" affordance yet (needs a native
menu/tray item - see the spec's out-of-scope follow-ups). To open a
different folder, quit the app, delete the remembered-workspace file, and
relaunch - the Open Folder dialog will show again:

```
rm "$HOME/Library/Application Support/zero-desktop/workspace.json"
```

## Known limitations

- **Offline completions are Ollama-only.** The Chrome-only Nano API
  (`window.LanguageModel`) doesn't exist in WKWebView (Safari's engine).
  Point `zero.ollamaUrl`/`zero.ollamaChatModel` at a running Ollama
  instance for completions inside the desktop app.
- **No timeout on daemon startup.** If the sidecar spawns but hangs before
  printing its ready line, the app has no window and no way to quit but
  Force Quit - tracked as a follow-up.

`window.prompt()`/`window.confirm()` don't work in Tauri's WKWebView
either (wry doesn't wire up the `WKUIDelegate` methods they need) -
`packages/web`'s file tree and terminal tab rename both use inline
editing instead, so this doesn't currently affect anything in
`packages/web`.

## Manual smoke-test checklist

Run before considering a change to this package done:

1. Fresh launch (no remembered workspace) shows the native Open Folder
   dialog.
2. Pick a folder - a window opens showing the Zero editor.
3. Open a file, edit it, save it - works.
4. Open the terminal panel, run a command - output appears (proves the
   bundled node-runtime works).
5. Ask chat a question - gets a response, or a clear "no model
   configured" state without an Ollama server running (expected, not a
   failure).
6. Quit the app.
7. Relaunch - the same folder opens automatically, no dialog shown.
