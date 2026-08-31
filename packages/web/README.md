# `@zero/web`

The browser client: React + CodeMirror 6 + xterm.js. Runs two ways -
against a `@zero/daemon` WebSocket (Zero, Zero Agents, the VS Code
extension's webview) or fully standalone with no daemon at all (Zero
Lite), using the same `@zero/core` engine either way.

## What's here

- `workbench/` - the daemon-backed editor shell:
  - `layout/` - panel layout (editor, terminal, chat, sidebar).
  - `filetree/`, `tabs/`, `viewers/` - file navigation, open-file tabs, and
    per-file-type viewers.
  - `terminal/` - xterm.js wired to the daemon's PTY sessions.
  - `chat/` - the chat panel, streaming `AgentRuntime` output.
  - `plugins/` - UI surfaces contributed by daemon plugins (Graphify,
    git, TODO scanner).
  - `commands/`, `palette/`, `keybindings/`, `search/`, `settings/`,
    `theme/` - command palette, keybinding config, search, settings UI,
    theming.
- `lite/` - Zero Lite: the zero-install path. No terminal, no LSP; browser
  `File System Access API` for the workspace and Chrome's Gemini Nano for
  completions/chat, `@zero/core` running with no daemon-backed providers.
- `testUtils/` - shared fakes for provider interfaces used across tests.

## Rules

- Anything that talks to the daemon goes through `@zero/protocol`'s typed
  client - no ad-hoc `fetch`/`WebSocket` calls to daemon endpoints.
- Zero Lite must keep working with every daemon-only feature (terminal,
  LSP) absent - guard those UI surfaces on daemon availability rather than
  assuming they exist.
