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

Use **File > Open Folder...** (`Cmd+O`) to open another workspace - it
opens a new window running its own daemon, alongside any windows already
open. The most recently opened workspace becomes the one that reopens
automatically on the next app launch.

## Known limitations

- **Offline completions are Ollama-only.** The Chrome-only Nano API
  (`window.LanguageModel`) doesn't exist in WKWebView (Safari's engine).
  Point `zero.ollamaUrl`/`zero.ollamaChatModel` at a running Ollama
  instance for completions inside the desktop app.

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
8. Rename the bundled `zero-daemon-sidecar` binary temporarily (so it
   fails to spawn) and confirm the app shows a failure dialog instead of
   hanging - then restore the binary's name.
9. With the app running, use **File > Open Folder...** to open a second,
   different folder - a new window opens showing that folder's editor,
   independent of the first window.
10. Confirm both windows work independently: edit and save a file in
    each, open a terminal and run a command in each.
11. Close one window - confirm the other keeps running normally.
12. Quit the app (Cmd+Q) - confirm no `zero-daemon-sidecar` processes
    remain (`ps aux | grep zero-daemon-sidecar`).
13. Relaunch - confirm the most-recently-opened-of-the-two folders
    reopens automatically.
