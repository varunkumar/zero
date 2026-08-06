# Workbench Polish: Palette, Theme, Icons, README

Date: 2026-08-06

## Context

Post-M2, a pass of small UI defects and one doc-freshness issue were reported
against `packages/web`:

1. The command palette (`packages/web/src/workbench/palette/`) doesn't look
   navigable via arrow keys.
2. Its font doesn't match the rest of the app (not FiraCode).
3. It shows no file icons, unlike the file tree.
4. Dark mode is unreadable in places.
5. File icons across the app are plain emoji, not the "rich" style users
   expect (e.g. vscode-icons).
6. `README.md`'s Status section says M2 (terminal/LSP) is still upcoming,
   but it has already shipped (PR #3, merged).

This spec covers root causes and fixes for all six, scoped to
`packages/web` plus the root `README.md`. No protocol, daemon, or core
changes are needed.

## 1. Command palette keyboard navigation

**Root cause:** `Palette.tsx` is built on `cmdk`, which already handles
arrow-up/down and Enter internally and marks the highlighted `Command.Item`
with `data-selected="true"`. No CSS targets that attribute, so the highlight
is invisible — navigation works, but looks broken.

**Fix:** Add a `[data-selected="true"]` style rule (or inline style keyed off
cmdk's selected state) to `Command.Item` in `Palette.tsx`, using
`--zero-selection-bg` / `--zero-selection-fg` (falling back to
`--zero-accent` for the left border/indicator) so it's visually consistent
with editor selection highlighting. No JS/behavior change.

## 2. Palette font

**Root cause:** `Palette.tsx` sets no `font-family`; it inherits the
browser default sans-serif. The editor (`Editor.tsx`) and terminal
(`TerminalHost.tsx`) both use the literal font stack
`"'FiraCode Nerd Font', 'Fira Code', monospace"`.

**Fix:** Apply the same font stack to the palette's `Command.Input` and
`Command.Item` elements. Since this literal now appears in three places,
hoist it to a single exported constant (e.g.
`packages/web/src/workbench/theme/fonts.ts`) and import it in all three
call sites rather than duplicating the string.

## 3. File icons in the palette

**Root cause:** `FileOpener.tsx` (the palette's file-open variant) renders
plain text labels via `getLabel`. Icons exist only in
`FileTreePanel.tsx`'s local `EXTENSION_ICONS` map / `iconFor()` helper —
nothing shares that logic with the palette.

**Fix:** Once the icon set from item 5 is in place, extract `iconFor(name,
isDir)` into a shared module (`packages/web/src/workbench/icons/iconFor.ts`)
used by both `FileTreePanel.tsx` and `FileOpener.tsx`. `Palette.tsx` gains
an optional `renderIcon?: (item: T) => ReactNode` prop so `CommandPalette`
(non-file commands) is unaffected while `FileOpener` supplies file icons.

## 4. Dark theme readability

**Root cause:** Not the palette or the Catppuccin Mocha dark palette itself
(`theme.css`), which is a standard, readable theme. Two components bypass
theming entirely:
- `Settings.tsx`: dropdown panel hardcodes `background: "#fff"`,
  `border: "1px solid #ccc"` — stays white-on-dark-text in dark mode.
- `StatusPill.tsx`: hardcodes `color: "#555"`, `border: "1px solid #ccc"`
  — low-contrast gray text regardless of theme.

Separately, `Editor.tsx`'s CodeMirror theme object and
`TerminalHost.tsx`'s xterm theme object duplicate the same hex values from
`theme.css` as JS literals (necessary since neither library reads CSS
custom properties directly), which is a maintenance hazard even though the
values currently match.

**Fix:**
- Point `Settings.tsx` and `StatusPill.tsx` at the existing `--zero-*`
  custom properties (`var(--zero-editor-bg)`, `var(--zero-border)`,
  `var(--zero-sidebar-fg)`, etc.) instead of hardcoded hex/gray.
- Add `packages/web/src/workbench/theme/palette.ts` exporting a
  `readZeroPalette(): Record<string, string>` that reads the `--zero-*`
  custom properties off `document.documentElement` via `getComputedStyle`
  at theme-construction time. `Editor.tsx` and `TerminalHost.tsx` call this
  instead of hardcoding hex literals, so `theme.css` becomes the single
  source of truth for all four consumers (CSS-styled components, CodeMirror,
  xterm, and any future JS-styled component).

## 5. Rich file icons (vscode-icons)

**Fix:** Bundle a curated subset of SVG icons from the vscode-icons project
into `packages/web/src/assets/icons/`, covering the extensions currently in
`EXTENSION_ICONS` (ts, tsx, js, json, md, css, scss, html, images, py, rs,
go, sh, yaml, toml, lock, env, gitignore, test) plus folder and default-file
icons (~20-25 files total). Fully local — no CDN fetch, no new npm
dependency, consistent with the project's local-first/offline constraint.

`iconFor(name, isDir)` (see item 3) returns an icon asset path/URL instead
of an emoji string; call sites render an `<img>`/inline SVG sized to match
the current emoji's footprint (16px, matching `FileTreePanel.tsx`'s
existing row height).

Licensing: vscode-icons is MIT-licensed; the subset ships with a short
attribution note (e.g. `assets/icons/LICENSE` or a line in this repo's
top-level `README.md`/`NOTICE`).

## 6. README status update

Update the `## Status` section to state M0, M1, and M2 are implemented
(daemon-served editor with save; offline copilot completions;
terminal via PTY and LSP diagnostics/hover/go-to-definition), and keep the
forward-looking list (Graphify, chat/AgentRuntime, Zero Agents, Zero Lite,
Claude plugin, Zero IDE) as still upcoming. No other README sections are in
scope.

## Testing

- `Palette.tsx` selected-state styling and font: visual only, no new unit
  test value: existing palette tests (if any) continue to pass unchanged.
- `iconFor()` extraction: unit test asserting the same extension -> icon
  mapping as today's `EXTENSION_ICONS`, now returning asset paths, colocated
  next to the new module (`iconFor.test.ts`).
- `readZeroPalette()`: unit test with a stubbed `getComputedStyle` asserting
  it reads the documented `--zero-*` properties and falls back sanely if a
  property is unset.
- Manual verification (per CLAUDE.md UI guidance): run the dev server, open
  the command palette and file opener in both themes, confirm keyboard
  highlight visibility, font, icons, and confirm Settings/StatusPill are
  legible in dark mode.

## Out of scope

- Changing the dark palette's actual color values (Catppuccin Mocha stays).
- Any protocol/daemon/core changes.
- Icon coverage beyond the current `EXTENSION_ICONS` extension list (no
  general-purpose "all vscode-icons" import).
