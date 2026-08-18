# Zero IDE (`zero-desktop`)

Tauri v2 desktop wrap around Zero: bundles `@zero/daemon` as a standalone
`bun build --compile` sidecar (with a portable node runtime for the
terminal) and opens the same web client in a native window. See
[`docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md`](../../docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md)
for the full design.

## Development

```
bun run --cwd packages/daemon build:sidecar   # compiles the daemon sidecar + bundles node-runtime/web-dist
bun run --cwd packages/web build              # builds the web UI the sidecar serves
bun run --cwd packages/desktop tauri dev      # launches the app
```

`tauri build` produces a release bundle under
`packages/desktop/src-tauri/target/release/bundle/`; its
`beforeBuildCommand` runs the sidecar build automatically, but
`packages/web`'s build is not wired into that hook yet - run it manually
first.

## Switching workspaces

There's no in-app "change workspace" affordance yet (needs a native
menu/tray item - see the spec's out-of-scope follow-ups). To open a
different folder, quit the app, delete the remembered-workspace file, and
relaunch - the Open Folder dialog will show again:

```
rm "$HOME/Library/Application Support/zero-desktop/workspace.json"
```

## Known limitations

- **New File / New Folder / Rename don't work.** `packages/web`'s
  `FileTreePanel.tsx` uses `window.prompt()`, which Tauri's WKWebView on
  macOS doesn't implement (wry doesn't wire up the `WKUIDelegate` methods
  it needs). The call silently returns nothing instead of showing a
  dialog. Fixing this means replacing those calls with an in-app modal in
  `packages/web` - tracked as a follow-up, not part of this milestone.
- **Offline completions are Ollama-only.** The Chrome-only Nano API
  (`window.LanguageModel`) doesn't exist in WKWebView (Safari's engine).
  Point `zero.ollamaUrl`/`zero.ollamaChatModel` at a running Ollama
  instance for completions inside the desktop app.

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
