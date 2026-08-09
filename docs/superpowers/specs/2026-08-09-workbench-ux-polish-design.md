# Workbench UX polish (2026-08-09)

A batch of small, mostly-independent UX/DX fixes and additions to the web
workbench and daemon, requested as a single backlog. Shipped as one worktree
and one PR; version bump is a patch bump (no milestone doc update - none of
these change the architecture described in the M5 design docs).

## Scope

### 1. Branding & status bar basics

- **Favicon**: add `packages/web/public/favicon.svg` derived from the
  existing `Logomark` component (`workbench/theme/Logomark.tsx`), reference
  it from `packages/web/index.html`.
- **GitHub remote link**: `StatusBar.tsx` gains a link to the repo's GitHub
  URL. Resolved server-side (daemon reads `git remote get-url origin` in the
  workspace root once at startup and exposes it via the existing
  daemon-info/handshake payload, or a small new RPC) - never hardcoded in web
  code, since the workbench is generic across workspaces.
- **Git status in status bar**: new daemon RPC `git/status` wrapping `git
  status --porcelain=v1 -b` in the workspace root, returning branch name,
  ahead/behind counts, and dirty-file count. `StatusBar.tsx` polls it the
  same way it already polls `graph/status`, and renders a pill (branch name +
  dirty indicator). Not on a workspace with no git repo: RPC returns `null`,
  status bar renders nothing for this pill (mirrors `graphStatus` null
  handling already in place).

### 2. Terminal/Chat panel UX

- **Tabbed, not stacked**: `Workbench.tsx` currently adds the Terminal and
  Chat panels as two separate dockview groups (`position: { direction:
  "below" }` each). Change so the second panel added targets the first as
  its `referencePanel` with a same-group position, producing one dockview
  group with two tabs - the same structure the sidebar already uses for
  Files/Search.
- **Live theme switching**: `ThemeProvider` is the single writer of
  `document.documentElement.dataset.theme` and already threads `theme:
  "light"|"dark"` through the tree. `terminal/theme.ts` / `TerminalHost.tsx`
  currently only apply an xterm theme once at mount. Subscribe the terminal
  host to the current theme (prop or context) and call `term.options.theme =
  ...` on change, so flipping the app theme restyles a live terminal
  in-place - no PTY restart, no reload.
- **Chat panel theming**: `ChatPanel.tsx` currently hardcodes colors instead
  of using the `--zero-*` custom properties defined in `theme/theme.css`.
  Restyle it to consume those tokens so it follows light/dark like the rest
  of the workbench.
- **PTY intermittent-load bug** (standalone spike, done first via
  systematic-debugging, before other terminal work): `pty.ts` already works
  around one Bun incompatibility (node-pty's native binding silently stops
  emitting `data` under Bun - only the first event ever arrives - so the PTY
  is hosted in a real `node` child process bridged over newline-delimited
  JSON on stdio). The reported "terminal window doesn't load sometimes" bug
  is a *different* failure in that same bridge and must be root-caused
  against real repro logs (worker spawn timing, `node` resolution in the
  actual launch environment, a race between worker-ready and the first
  `pty/open` call, etc.) rather than patched speculatively. Output of the
  spike: a committed regression test (`pty.test.ts`) covering whatever race
  or condition is found, plus the fix.

### 3. Chat panel UX

- **Thinking/typing indicator**: `turnStore.ts` already streams
  `ChatTurnEventPayload` events as the agent works. Derive an "agent is
  responding" boolean from turn-open/turn-close events and render an inline
  typing indicator in `ChatPanel.tsx` while true.
- **Session switcher as dropdown**: replace the current tab-per-session UI
  with a single dropdown/select sourced from `ChatStore`'s existing session
  list; selecting an entry switches the active session the same way clicking
  a tab does today.
- **Avatars + timestamps**: each rendered message gets a small avatar
  (agent vs. user, static icon) and a timestamp, using the timestamp already
  on stored message records (falls back to render-time if a given historical
  record predates this field).
- **Scroll-to-bottom button**: appears when the user has scrolled the
  message list away from the bottom; clicking scrolls smoothly to the latest
  message. Also appears (without requiring a click) as a small "new message"
  affordance if a message arrives while scrolled up.
- **Theming**: covered by the theme-token pass in section 2.

### 4. File panel CRUD (create / rename / delete / move / copy)

- **Daemon**: extend `workspace.ts` with fs RPCs following the existing
  `fs/read`, `fs/write`, `fs/tree` pattern: `fs/create` (file or dir),
  `fs/rename`, `fs/delete`, `fs/move`, `fs/copy`. Same path-containment and
  error-shape conventions as the existing fs RPCs (reject paths that escape
  the workspace root).
- **Web**: `FileTreePanel.tsx` gains a right-click context menu per node
  (new file, new folder, rename, delete, and - once a node is "cut" or
  "copied" via the menu - paste-as-move / paste-as-copy on a target folder).
  Keyboard shortcuts registered through the existing
  `keybindings/dispatcher.ts` + `commands/registry.ts` pattern (so they also
  show up in the command palette, consistent with how other file-tree
  actions already work). Destructive actions (delete) get an inline confirm,
  matching the existing unsaved-changes confirm pattern in `TabStrip`.

### 5. Indicators & misc

- **Model indicator clarity**: the two unlabeled model pills in
  `Settings.tsx` / `StatusPill.tsx` get explicit labels - "Completion model"
  and "Chat model" - so it's clear at a glance which is which.
- **Context window size in status bar**: `@zero/core`'s `tokenLedger.ts`
  already tracks token estimates per the project's `Math.ceil(chars/4)`
  convention. Surface used/remaining tokens (against the active chat
  model's context window) as a new `StatusBar` pill, updating as the ledger
  updates.
- **Editor tab file-type icons**: already implemented and tested at
  `workbench/icons/iconFor.ts` (used today by `FileTreePanel`). Wire the same
  `iconFor(name, isDir)` call into `TabStrip` in `Workbench.tsx` so open-file
  tabs show the same icon as the tree. No new icon assets needed.
- **`zero serve` + PTY**: verified already correct - `main.ts` unconditionally
  constructs `PtyService` and registers all `pty/*` RPCs, and `bin/zero.ts`'s
  `serve` branch calls the same `startZero` path the TUI uses. This item is
  a regression test addition (assert `pty/open` works end-to-end when
  launched via the `serve` code path), not a functional fix.

## Out of scope

- Any change to the M5/M5.1 agent runtime, protocol shapes beyond the new
  `git/status` and `fs/*` RPCs, or CLI TUI behavior.
- Multi-workspace or remote-git-host abstractions for the GitHub link (only
  `origin` is read).

## Testing

- Daemon: unit tests for each new RPC (`git/status`, `fs/create`,
  `fs/rename`, `fs/delete`, `fs/move`, `fs/copy`) alongside existing
  `workspace.test.ts` patterns; a `pty.test.ts` regression test for whatever
  the PTY spike finds; a `main.test.ts`/`server.test.ts` assertion that PTY
  RPCs are registered on the `serve` path.
- Web: unit tests for the tab-icon wiring, context-menu commands, theme
  propagation to the terminal host, and the chat typing-indicator/derived
  state, following the existing co-located `*.test.ts` convention.
- Manual: exercise the terminal and chat tabs, theme toggle, and file CRUD
  via the running app (`bun run dev` or equivalent) before opening the PR,
  since several of these are UI/UX changes that tests alone won't fully
  validate.

## Versioning

Bump `package.json` version as a patch release once implementation lands.
