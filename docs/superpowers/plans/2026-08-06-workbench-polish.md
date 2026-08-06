# Workbench Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix command-palette keyboard-highlight visibility, font, and file icons; fix dark-theme readability bugs in `Settings.tsx`/`StatusPill.tsx`; replace emoji file icons with bundled vscode-icons SVGs; update the README's Status section for M2.

**Architecture:** All changes are confined to `packages/web` (React/Vite client) plus the root `README.md`. No protocol, daemon, or core changes. Font and color constants are hoisted into small shared modules under `packages/web/src/workbench/theme/` so the editor, terminal, and palette read from one source instead of duplicating literals. File icons move from an emoji map in `FileTreePanel.tsx` to a shared `iconFor()` helper backed by bundled SVG assets, used by both the file tree and the command palette's file opener.

**Tech Stack:** React 18, Vite 6 (plain `@vitejs/plugin-react`, no SVGR — SVG imports resolve to URL strings), `cmdk` 1.1.1, `bun:test` (no DOM/jsdom available in this workspace — all new tests must be pure-logic, no `document`/`getComputedStyle`).

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs — not touched by this plan.
- All packages: TypeScript `strict: true`, ESM only.
- Token estimate convention and completion budgets: not applicable to this plan.
- Runtime floor: Bun >= 1.1.
- Commit after each coherent unit of work; conventional-commit style messages.
- New behavior needs tests alongside it; `bun:test` only — no DOM/jsdom dependency exists in this workspace, so tests must stay pure-function (no rendering, no `getComputedStyle`).

---

## Design deviation from the spec (read before starting)

`docs/superpowers/specs/2026-08-06-workbench-polish-design.md` section 4 proposed a
`readZeroPalette()` helper that reads `--zero-*` CSS custom properties via
`getComputedStyle` at runtime. This workspace has no DOM/jsdom test
dependency (`packages/web`'s existing tests — e.g. `theme.test.ts` — are
pure-function, no `document`), and adding one would be new infrastructure
the codebase doesn't otherwise need. Task 6 below instead hoists the
duplicated hex literals into a plain TypeScript constants module
(`workbench/theme/colors.ts`) that `Editor.tsx` and `terminal/theme.ts`
both import. `theme.css` remains the separate source of truth for
CSS-styled components (as documented already in `Editor.tsx`'s existing
comment explaining why CodeMirror can't read CSS custom properties). This
still satisfies the spec's goal — one source of truth for the two
JS-styled consumers — without adding DOM test machinery. All other spec
sections are implemented as written.

---

## Task 1: Shared monospace font constant + palette font fix

**Files:**
- Create: `packages/web/src/workbench/theme/fonts.ts`
- Create: `packages/web/src/workbench/theme/fonts.test.ts`
- Modify: `packages/web/src/workbench/palette/Palette.tsx`
- Modify: `packages/web/src/Editor.tsx:71,75` (replace literal with import)
- Modify: `packages/web/src/workbench/terminal/TerminalHost.tsx:23` (replace literal with import)

**Interfaces:**
- Produces: `export const ZERO_MONO_FONT: string` from `workbench/theme/fonts.ts` — the exact string `"'FiraCode Nerd Font', 'Fira Code', monospace"`, imported by `Palette.tsx`, `Editor.tsx`, and `TerminalHost.tsx`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/workbench/theme/fonts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ZERO_MONO_FONT } from "./fonts";

describe("ZERO_MONO_FONT", () => {
  test("is the FiraCode stack with a generic monospace fallback", () => {
    expect(ZERO_MONO_FONT).toBe("'FiraCode Nerd Font', 'Fira Code', monospace");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun test src/workbench/theme/fonts.test.ts`
Expected: FAIL — `Cannot find module './fonts'` (or similar resolution error).

- [ ] **Step 3: Implement the constant**

Create `packages/web/src/workbench/theme/fonts.ts`:

```ts
/** Shared monospace font stack for the editor, terminal, and command palette. */
export const ZERO_MONO_FONT = "'FiraCode Nerd Font', 'Fira Code', monospace";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun test src/workbench/theme/fonts.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the constant into Editor.tsx**

In `packages/web/src/Editor.tsx`, add the import near the top (after the existing imports, before `toCmDiagnostics`):

```ts
import { ZERO_MONO_FONT } from "./workbench/theme/fonts";
```

Then replace both occurrences of the literal inside `fontTheme` (currently at lines 71 and 75):

```ts
const fontTheme = EditorView.theme({
  "&": {
    ...editorLayoutStyle["&"],
    fontFamily: ZERO_MONO_FONT,
  },
  ".cm-scroller": editorLayoutStyle[".cm-scroller"],
  ".cm-content": {
    fontFamily: ZERO_MONO_FONT,
    fontFeatureSettings: "'liga' 1, 'calt' 1",
  },
  ".cm-content, .cm-gutters": { lineHeight: "1.6" },
});
```

- [ ] **Step 6: Wire the constant into TerminalHost.tsx**

In `packages/web/src/workbench/terminal/TerminalHost.tsx`, add the import:

```ts
import { ZERO_MONO_FONT } from "../theme/fonts";
```

Replace the literal at line 23:

```ts
    const t = new Terminal({
      convertEol: true,
      fontFamily: ZERO_MONO_FONT,
      theme: terminalTheme(props.theme),
    });
```

- [ ] **Step 7: Apply the font to the command palette**

In `packages/web/src/workbench/palette/Palette.tsx`, add the import:

```ts
import { ZERO_MONO_FONT } from "../theme/fonts";
```

Add `fontFamily: ZERO_MONO_FONT` to the panel's style object (the div with `background: "var(--zero-editor-bg)"`, currently lines 32-42) and to `Command.Input`'s style object (currently lines 49-58) — form controls like `<input>` don't inherit `font-family` from ancestors in most browsers, so it needs to be explicit on the input too:

```tsx
      <div
        style={{
          background: "var(--zero-editor-bg)",
          color: "var(--zero-editor-fg)",
          width: 480,
          maxHeight: "60vh",
          borderRadius: 8,
          border: "1px solid var(--zero-border)",
          overflow: "hidden",
          fontFamily: ZERO_MONO_FONT,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Command label={props.placeholder} shouldFilter={props.filter ?? true}>
          <Command.Input
            autoFocus
            placeholder={props.placeholder}
            onValueChange={props.onQueryChange}
            style={{
              width: "100%",
              padding: 12,
              border: "none",
              borderBottom: "1px solid var(--zero-border)",
              background: "transparent",
              color: "inherit",
              outline: "none",
              boxSizing: "border-box",
              fontFamily: ZERO_MONO_FONT,
            }}
          />
```

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/workbench/theme/fonts.ts packages/web/src/workbench/theme/fonts.test.ts packages/web/src/Editor.tsx packages/web/src/workbench/terminal/TerminalHost.tsx packages/web/src/workbench/palette/Palette.tsx
git commit -m "fix(web): use FiraCode consistently in the command palette"
```

---

## Task 2: Command palette keyboard-selection highlight

**Files:**
- Modify: `packages/web/src/workbench/palette/Palette.tsx`

**Interfaces:**
- Consumes: `ZERO_MONO_FONT` from Task 1 (file already imports it).
- Produces: no new exports; visual-only change.

`cmdk`'s `Command.Item` already receives keyboard-driven `data-selected="true"` and `cmdk-item=""` attributes at runtime when highlighted (confirmed in `node_modules/cmdk/dist/index.js`: `n.createElement(D.Primitive.div,{...,"cmdk-item":"",role:"option","aria-selected":!!v,"data-selected":!!v,...})`), but no CSS targets that state, so arrow-key navigation is invisible. Inline `style` props can't express attribute selectors, so this needs a scoped `<style>` tag.

- [ ] **Step 1: Add a scoped stylesheet and selected-state styling**

In `packages/web/src/workbench/palette/Palette.tsx`, give the outer panel `<div>` a class and render a `<style>` tag as its first child, before `<Command>`:

```tsx
      <div
        className="zero-palette"
        style={{
          background: "var(--zero-editor-bg)",
          color: "var(--zero-editor-fg)",
          width: 480,
          maxHeight: "60vh",
          borderRadius: 8,
          border: "1px solid var(--zero-border)",
          overflow: "hidden",
          fontFamily: ZERO_MONO_FONT,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <style>{`
          .zero-palette [cmdk-item][data-selected="true"] {
            background: var(--zero-selection-bg);
            color: var(--zero-selection-fg);
          }
        `}</style>
        <Command label={props.placeholder} shouldFilter={props.filter ?? true}>
```

- [ ] **Step 2: Remove the now-redundant per-item background from inline styles (none exists)**

`Command.Item`'s existing style (`{ padding: "8px 12px", borderRadius: 4, cursor: "pointer" }`) sets no background, so nothing to remove — confirm by re-reading the file after Step 1 that no conflicting inline `background` is set on `Command.Item`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `bun run dev` (or the project's existing dev script), open the app, press the command-palette shortcut, press Arrow Down/Up repeatedly, and confirm the highlighted row now has a visible background in both light and dark theme (toggle theme via whatever mechanism `ThemeProvider` exposes in the running app). Record the result in the task notes; this step has no automated check since it's purely visual.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/palette/Palette.tsx
git commit -m "fix(web): show a visible highlight for command-palette keyboard navigation"
```

---

## Task 3: Fetch curated vscode-icons SVG assets

**Files:**
- Create: `packages/web/src/assets/icons/` (22 SVG files, listed below)
- Create: `packages/web/src/assets/icons/NOTICE.md`

**Interfaces:**
- Produces: file assets at fixed paths, consumed by Task 4's `iconFor.ts`. Filenames (verified against the `vscode-icons/vscode-icons` `master` branch tree — all confirmed present via `gh api repos/vscode-icons/vscode-icons/git/trees/master?recursive=1`):
  - `default_file.svg`, `default_folder.svg`
  - `file_type_typescript.svg`, `file_type_reactts.svg`, `file_type_js.svg`, `file_type_reactjs.svg`
  - `file_type_json.svg`, `file_type_markdown.svg`, `file_type_css.svg`, `file_type_scss.svg`
  - `file_type_html.svg`, `file_type_image.svg`, `file_type_svg.svg`
  - `file_type_python.svg`, `file_type_rust.svg`, `file_type_go.svg`, `file_type_shell.svg`
  - `file_type_yaml.svg`, `file_type_toml.svg`, `file_type_dotenv.svg`
  - `file_type_git.svg`, `file_type_testjs.svg`

This is an asset-fetch task, not a code task — no test-first cycle applies to downloading static files. The verification step (Step 3) is the equivalent check.

- [ ] **Step 1: Create the assets directory**

```bash
mkdir -p packages/web/src/assets/icons
```

- [ ] **Step 2: Download the curated icon set**

```bash
cd packages/web/src/assets/icons
base="https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons"
for f in \
  default_file.svg default_folder.svg \
  file_type_typescript.svg file_type_reactts.svg file_type_js.svg file_type_reactjs.svg \
  file_type_json.svg file_type_markdown.svg file_type_css.svg file_type_scss.svg \
  file_type_html.svg file_type_image.svg file_type_svg.svg \
  file_type_python.svg file_type_rust.svg file_type_go.svg file_type_shell.svg \
  file_type_yaml.svg file_type_toml.svg file_type_dotenv.svg \
  file_type_git.svg file_type_testjs.svg
do
  curl -sf -o "$f" "$base/$f"
done
cd -
```

- [ ] **Step 3: Verify all 22 files downloaded and are non-empty SVGs**

```bash
cd packages/web/src/assets/icons
ls | wc -l
for f in *.svg; do
  if [ ! -s "$f" ]; then echo "EMPTY: $f"; fi
  head -c 5 "$f"
  echo " <- $f"
done
cd -
```

Expected: `22` from `wc -l`; every file's first bytes start with `<?xml` or `<svg`; no `EMPTY:` lines.

- [ ] **Step 4: Add attribution**

Create `packages/web/src/assets/icons/NOTICE.md`:

```markdown
# Icon attribution

The SVG files in this directory are sourced from the
[vscode-icons](https://github.com/vscode-icons/vscode-icons) project,
licensed under the MIT License. See
https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE for the
full license text.
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/assets/icons
git commit -m "chore(web): bundle a curated vscode-icons SVG set"
```

---

## Task 4: Shared `iconFor()` helper

**Files:**
- Create: `packages/web/src/workbench/icons/iconFor.ts`
- Create: `packages/web/src/workbench/icons/iconFor.test.ts`

**Interfaces:**
- Consumes: the SVG assets from Task 3 at `packages/web/src/assets/icons/*.svg`.
- Produces: `export function iconFor(name: string, isDir: boolean): string` — returns a Vite-resolved asset URL string. Consumed by Task 5 (`FileTreePanel.tsx`) and Task 6 (`FileOpener.tsx`/`Palette.tsx`).

This replaces `FileTreePanel.tsx`'s local `EXTENSION_ICONS` map and `iconFor(node)` function (currently `packages/web/src/workbench/filetree/FileTreePanel.tsx:31-65`) with a shared, asset-backed version keyed by filename instead of a `Node`, so it works for both the file tree and the palette (which only has path strings, not `Node` objects).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/workbench/icons/iconFor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { iconFor } from "./iconFor";

describe("iconFor", () => {
  test("returns the folder icon for directories regardless of name", () => {
    expect(iconFor("src", true)).toContain("default_folder");
  });

  test.each([
    ["index.ts", "typescript"],
    ["App.tsx", "reactts"],
    ["main.js", "file_type_js"],
    ["Widget.jsx", "reactjs"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["styles.css", "file_type_css"],
    ["app.scss", "scss"],
    ["index.html", "html"],
    ["logo.png", "image"],
    ["icon.svg", "file_type_svg"],
    ["script.py", "python"],
    ["main.rs", "rust"],
    ["main.go", "file_type_go"],
    ["run.sh", "shell"],
    ["config.yaml", "yaml"],
    ["Cargo.toml", "toml"],
    [".env", "dotenv"],
    [".gitignore", "file_type_git"],
  ] as const)("maps %s to an icon containing %s", (name, fragment) => {
    expect(iconFor(name, false)).toContain(fragment);
  });

  test("falls back to the default file icon for unknown extensions", () => {
    expect(iconFor("data.xyz123", false)).toContain("default_file");
  });

  test("falls back to the default file icon for extensionless files", () => {
    expect(iconFor("LICENSE", false)).toContain("default_file");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun test src/workbench/icons/iconFor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `iconFor`**

Create `packages/web/src/workbench/icons/iconFor.ts`:

```ts
import defaultFile from "../../assets/icons/default_file.svg";
import defaultFolder from "../../assets/icons/default_folder.svg";
import typescript from "../../assets/icons/file_type_typescript.svg";
import reactts from "../../assets/icons/file_type_reactts.svg";
import js from "../../assets/icons/file_type_js.svg";
import reactjs from "../../assets/icons/file_type_reactjs.svg";
import json from "../../assets/icons/file_type_json.svg";
import markdown from "../../assets/icons/file_type_markdown.svg";
import css from "../../assets/icons/file_type_css.svg";
import scss from "../../assets/icons/file_type_scss.svg";
import html from "../../assets/icons/file_type_html.svg";
import image from "../../assets/icons/file_type_image.svg";
import svg from "../../assets/icons/file_type_svg.svg";
import python from "../../assets/icons/file_type_python.svg";
import rust from "../../assets/icons/file_type_rust.svg";
import go from "../../assets/icons/file_type_go.svg";
import shell from "../../assets/icons/file_type_shell.svg";
import yaml from "../../assets/icons/file_type_yaml.svg";
import toml from "../../assets/icons/file_type_toml.svg";
import dotenv from "../../assets/icons/file_type_dotenv.svg";
import git from "../../assets/icons/file_type_git.svg";
import testFile from "../../assets/icons/file_type_testjs.svg";

const EXTENSION_ICONS: Record<string, string> = {
  ts: typescript,
  tsx: reactts,
  js,
  jsx: reactjs,
  json,
  md: markdown,
  mdx: markdown,
  css,
  scss,
  sass: scss,
  html,
  png: image,
  jpg: image,
  jpeg: image,
  gif: image,
  svg,
  py: python,
  rs: rust,
  go,
  sh: shell,
  bash: shell,
  yml: yaml,
  yaml,
  toml,
  env: dotenv,
  gitignore: git,
  test: testFile,
};

/** Maps a file/directory name to a bundled vscode-icons SVG asset URL. */
export function iconFor(name: string, isDir: boolean): string {
  if (isDir) return defaultFolder;
  const dotIndex = name.lastIndexOf(".");
  // Leading-dot files like ".gitignore" have no extension by this rule
  // (dotIndex === 0), so fall back to matching the whole name below.
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1) : "";
  if (ext && EXTENSION_ICONS[ext]) return EXTENSION_ICONS[ext];
  const wholeName = name.startsWith(".") ? name.slice(1) : name;
  return EXTENSION_ICONS[wholeName] ?? defaultFile;
}
```

Note: `.gitignore` has `dotIndex === 0`, so `ext` is `""` and the whole-name
branch matches `"gitignore"` against `EXTENSION_ICONS.gitignore`. `.env`
follows the same path, matching `EXTENSION_ICONS.env`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun test src/workbench/icons/iconFor.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`

If TypeScript complains about missing type declarations for `*.svg` imports, add a module declaration. Check first whether one already exists:

```bash
grep -rl "declare module.*svg" packages/web/src
```

If none exists, create `packages/web/src/vite-env.d.ts` (or extend it if present) with:

```ts
/// <reference types="vite/client" />
```

Vite's client types already declare `*.svg` imports as `string`; this reference is the standard way to bring them in and should resolve the error without a custom declaration.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/icons packages/web/src/vite-env.d.ts
git commit -m "feat(web): add shared iconFor() helper backed by vscode-icons assets"
```

(Omit `vite-env.d.ts` from the `git add` if it wasn't created/modified.)

---

## Task 5: Wire icons into the file tree

**Files:**
- Modify: `packages/web/src/workbench/filetree/FileTreePanel.tsx`

**Interfaces:**
- Consumes: `iconFor(name: string, isDir: boolean): string` from Task 4.

**Deletes:** the local `EXTENSION_ICONS` map and `iconFor(node: Node): string` function (current lines 31-65), replaced by the shared import.

- [ ] **Step 1: Replace the local icon map with the shared helper**

In `packages/web/src/workbench/filetree/FileTreePanel.tsx`, remove lines 31-65 (`const EXTENSION_ICONS = {...}` through the closing `}` of the local `iconFor` function) and add this import at the top of the file, alongside the existing imports:

```ts
import { iconFor } from "../icons/iconFor";
```

- [ ] **Step 2: Update the `Row` renderer to use an `<img>` instead of an emoji span**

Replace the current `Row` function's icon rendering:

```tsx
function Row({ node, style, dragHandle }: NodeRendererProps<Node>) {
  const indent = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        paddingLeft: indent + 8,
        paddingRight: 12,
        cursor: node.data.kind === "file" ? "pointer" : "default",
        display: "flex", gap: 6, alignItems: "center",
        background: node.isSelected ? "var(--zero-selection-bg)" : "transparent",
        color: node.isSelected ? "var(--zero-selection-fg)" : "inherit",
      }}
      onClick={() => {
        if (node.data.kind === "dir") node.toggle();
      }}
    >
      <img src={iconFor(node.data.name, node.data.kind === "dir")} alt="" width={16} height={16} style={{ flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.name}</span>
    </div>
  );
}
```

(Only the icon line changes — from `<span>{iconFor(node.data)}</span>` to the `<img>` above — the rest of the function is unchanged.)

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

- [ ] **Step 4: Run the web package's test suite**

Run: `cd packages/web && bun test`
Expected: all existing tests still pass (no test referenced the removed `EXTENSION_ICONS`/local `iconFor`).

- [ ] **Step 5: Manual verification**

Run the dev server, open the file tree, confirm rich icons render for `.ts`/`.tsx`/`.json`/etc. files and a folder icon renders for directories, in both themes.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/filetree/FileTreePanel.tsx
git commit -m "refactor(web): use shared iconFor() SVG icons in the file tree"
```

---

## Task 6: Wire icons into the command palette's file opener

**Files:**
- Modify: `packages/web/src/workbench/palette/Palette.tsx`
- Modify: `packages/web/src/workbench/palette/FileOpener.tsx`

**Interfaces:**
- Consumes: `iconFor(name: string, isDir: boolean): string` from Task 4; `Palette` component from Task 1/2 (font + selection highlight already applied).
- Produces: `Palette<T>` gains an optional `renderIcon?: (item: T) => ReactNode` prop, so `CommandPalette` (non-file commands) is unaffected while `FileOpener` supplies file icons.

- [ ] **Step 1: Add an optional `renderIcon` prop to `Palette`**

In `packages/web/src/workbench/palette/Palette.tsx`, add `ReactNode` to the React import and extend the props type:

```ts
import type { ReactNode } from "react";
```

Add to the props type (alongside the existing `onQueryChange`/`filter` optional props):

```ts
  /** Optional per-item leading icon, rendered before the label. */
  renderIcon?: (item: T) => ReactNode;
```

Update the `Command.Item` rendering to place the icon before the label:

```tsx
            {props.items.map((item, i) => (
              <Command.Item
                key={`${props.getLabel(item)}:${i}`}
                value={props.getLabel(item)}
                onSelect={() => {
                  props.onSelect(item);
                  props.onClose();
                }}
                style={{ padding: "8px 12px", borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
              >
                {props.renderIcon?.(item)}
                {props.getLabel(item)}
              </Command.Item>
            ))}
```

- [ ] **Step 2: Supply icons from `FileOpener`**

In `packages/web/src/workbench/palette/FileOpener.tsx`, add the import:

```ts
import { iconFor } from "../icons/iconFor";
```

Update the `<Palette>` usage to pass `renderIcon`:

```tsx
  return (
    <Palette
      open={props.open}
      onClose={props.onClose}
      items={items}
      getLabel={(p) => p}
      onSelect={props.onOpen}
      placeholder="Go to file…"
      onQueryChange={setQuery}
      filter={false}
      renderIcon={(path) => (
        <img src={iconFor(path.split("/").at(-1)!, false)} alt="" width={16} height={16} style={{ flexShrink: 0 }} />
      )}
    />
  );
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

- [ ] **Step 4: Run the web package's test suite**

Run: `cd packages/web && bun test`
Expected: all tests pass, including the existing `FileOpener.test.ts` (which tests `rankPaths`, unaffected by this change) and `iconFor.test.ts` from Task 4.

- [ ] **Step 5: Manual verification**

Run the dev server, open the file opener (Cmd/Ctrl+P or whatever binding `commands/registry` wires it to), confirm each result row shows a file icon matching its extension, and that `CommandPalette` (the non-file command list) still renders correctly with no icon column.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/workbench/palette/Palette.tsx packages/web/src/workbench/palette/FileOpener.tsx
git commit -m "feat(web): show file icons in the command palette's file opener"
```

---

## Task 7: Fix Settings.tsx and StatusPill.tsx dark-mode readability

**Files:**
- Modify: `packages/web/src/Settings.tsx`
- Modify: `packages/web/src/StatusPill.tsx`

**Interfaces:** none — both are leaf presentational components with no props/exports changing.

- [ ] **Step 1: Fix `Settings.tsx`'s hardcoded colors**

In `packages/web/src/Settings.tsx`, replace the dropdown panel's style (currently `background: "#fff"`, `border: "1px solid #ccc"`, lines 20-35):

```tsx
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "100%",
            marginTop: 4,
            padding: 8,
            background: "var(--zero-editor-bg)",
            color: "var(--zero-editor-fg)",
            border: "1px solid var(--zero-border)",
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            zIndex: 10,
            minWidth: 220,
          }}
        >
```

- [ ] **Step 2: Fix `StatusPill.tsx`'s hardcoded colors**

In `packages/web/src/StatusPill.tsx`, replace the pill's style (currently `border: "1px solid #ccc"`, `color: "#555"`, lines 17-27):

```tsx
    <div
      title={status.reason ?? undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 12,
        border: "1px solid var(--zero-border)",
        fontSize: 14,
        color: "var(--zero-statusbar-fg)",
      }}
    >
```

Leave the status-dot `background: active ? "#2ecc71" : "#999"` (lines 33) as-is — those are semantic status colors (green = active, gray = inactive), not theme-mode colors, and read fine on both light and dark backgrounds.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

- [ ] **Step 4: Manual verification**

Run the dev server, switch to dark theme, open Settings and confirm the dropdown is dark-background/light-text and legible; confirm the status pill's text is legible against the dark statusbar/toolbar background.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/Settings.tsx packages/web/src/StatusPill.tsx
git commit -m "fix(web): make Settings and StatusPill respect the active theme"
```

---

## Task 8: Dedupe editor/terminal color literals into a shared module

**Files:**
- Create: `packages/web/src/workbench/theme/colors.ts`
- Create: `packages/web/src/workbench/theme/colors.test.ts`
- Modify: `packages/web/src/Editor.tsx:35-57`
- Modify: `packages/web/src/workbench/terminal/theme.ts`

**Interfaces:**
- Produces: `export const ZERO_COLORS: { dark: {...}; light: {...} }` from `workbench/theme/colors.ts`, matching the exact hex values already in `theme.css`, `Editor.tsx`, and `terminal/theme.ts`.
- Consumes (by Task's own downstream files): none new — `Editor.tsx` and `terminal/theme.ts` already exist and get modified in place.

This mirrors the values in `theme.css` (`packages/web/src/workbench/theme/theme.css`) exactly. `theme.css` itself is untouched — this only removes the duplication between `Editor.tsx` and `terminal/theme.ts`, per the design deviation noted above.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/workbench/theme/colors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ZERO_COLORS } from "./colors";

describe("ZERO_COLORS", () => {
  test("dark palette matches theme.css's --zero-editor-bg/fg", () => {
    expect(ZERO_COLORS.dark.editorBg).toBe("#1e1e2e");
    expect(ZERO_COLORS.dark.editorFg).toBe("#cdd6f4");
  });

  test("light palette matches theme.css's --zero-editor-bg/fg", () => {
    expect(ZERO_COLORS.light.editorBg).toBe("#ffffff");
    expect(ZERO_COLORS.light.editorFg).toBe("#1e1e2e");
  });

  test("dark cursor is not invisible against the dark background", () => {
    expect(ZERO_COLORS.dark.cursor).not.toBe(ZERO_COLORS.dark.editorBg);
  });

  test("light cursor is not invisible against the light background", () => {
    expect(ZERO_COLORS.light.cursor).not.toBe(ZERO_COLORS.light.editorBg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun test src/workbench/theme/colors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ZERO_COLORS`**

Create `packages/web/src/workbench/theme/colors.ts`:

```ts
/**
 * Color literals shared by CodeMirror's EditorView.theme() and xterm's
 * ITheme, both of which need plain JS color values rather than CSS custom
 * properties (see the comment in Editor.tsx explaining why). These values
 * must be kept in sync with the corresponding --zero-* properties in
 * theme.css by hand — there is no automated link between the two.
 */
export const ZERO_COLORS = {
  dark: {
    editorBg: "#1e1e2e",
    editorFg: "#cdd6f4",
    gutterBg: "#181825",
    gutterFg: "#6c7086",
    activeLineGutterBg: "#313244",
    cursor: "#cdd6f4",
  },
  light: {
    editorBg: "#ffffff",
    editorFg: "#1e1e2e",
    gutterBg: "#f5f5f7",
    gutterFg: "#6e6e73",
    activeLineGutterBg: "#e5e5ea",
    cursor: "#1e1e2e",
  },
} as const;
```

Note: `light.editorFg`/`light.cursor` use `#1e1e2e` — `theme.css`'s
canonical `--zero-editor-fg` for light mode — rather than xterm's old
literal `#1d1d1f` (near-identical near-black; the terminal's rendered text
color shifts imperceptibly). `Editor.tsx`'s light CodeMirror theme never
set an explicit `color` on `&`/`.cm-cursor` (it relies on CodeMirror's own
default text color), so this task leaves that alone and does not add one —
only `editorBg`/`gutterBg`/`gutterFg`/`activeLineGutterBg` are pulled from
`ZERO_COLORS.light` into `Editor.tsx` in Step 5. `ZERO_COLORS.light.editorFg`/
`cursor` are consumed only by `terminal/theme.ts` in Step 6, achieving one
canonical light-foreground value (theme.css's) shared by the non-CodeMirror
consumers.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun test src/workbench/theme/colors.test.ts`
Expected: PASS

- [ ] **Step 5: Consume `ZERO_COLORS` in `Editor.tsx`**

In `packages/web/src/Editor.tsx`, add the import:

```ts
import { ZERO_COLORS } from "./workbench/theme/colors";
```

Replace the `editorTheme` object's hardcoded hex literals (current lines 35-57) with `ZERO_COLORS` references, keeping every other value (comments, rgba overlays, selection colors) exactly as-is:

```ts
const editorTheme = {
  light: EditorView.theme({
    "&": { fontSize: "15px" },
    ".cm-gutters": { backgroundColor: ZERO_COLORS.light.gutterBg, color: ZERO_COLORS.light.gutterFg, border: "none" },
    ".cm-activeLineGutter": { backgroundColor: ZERO_COLORS.light.activeLineGutterBg },
    ".cm-activeLine": { backgroundColor: "rgba(0, 0, 0, 0.035)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(0, 122, 255, 0.28) !important" },
    ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, rgba(60, 60, 67, 0.25) 12%, transparent 5%)" },
  }),
  dark: EditorView.theme({
    "&": { fontSize: "15px", backgroundColor: ZERO_COLORS.dark.editorBg, color: ZERO_COLORS.dark.editorFg },
    ".cm-content": { caretColor: ZERO_COLORS.dark.cursor },
    ".cm-gutters": { backgroundColor: ZERO_COLORS.dark.gutterBg, color: ZERO_COLORS.dark.gutterFg, border: "none" },
    ".cm-activeLineGutter": { backgroundColor: ZERO_COLORS.dark.activeLineGutterBg },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.045)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(116, 199, 236, 0.32) !important" },
    ".cm-cursor": { borderLeftColor: ZERO_COLORS.dark.cursor },
    ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, rgba(205, 214, 244, 0.22) 12%, transparent 5%)" },
  }, { dark: true }),
};
```

(Leave the surrounding comment at lines 22-34 in place — it still correctly explains why these are JS literals instead of CSS vars.)

- [ ] **Step 6: Consume `ZERO_COLORS` in `terminal/theme.ts`**

Replace `packages/web/src/workbench/terminal/theme.ts` in full:

```ts
import type { ITheme } from "@xterm/xterm";
import { ZERO_COLORS } from "../theme/colors";

// xterm.js defaults cursor/cursorAccent to white when unset, which is
// invisible against a light background - both themes must set it
// explicitly, not just override background/foreground.
export function terminalTheme(theme: "light" | "dark"): ITheme {
  return theme === "dark"
    ? { background: ZERO_COLORS.dark.editorBg, foreground: ZERO_COLORS.dark.editorFg, cursor: ZERO_COLORS.dark.cursor, cursorAccent: ZERO_COLORS.dark.editorBg }
    : { background: ZERO_COLORS.light.editorBg, foreground: ZERO_COLORS.light.editorFg, cursor: ZERO_COLORS.light.cursor, cursorAccent: ZERO_COLORS.light.editorBg };
}
```

- [ ] **Step 7: Run the existing terminal theme test to confirm no regression**

Run: `cd packages/web && bun test src/workbench/terminal/theme.test.ts`
Expected: PASS (unchanged assertions, now backed by `ZERO_COLORS`).

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`

- [ ] **Step 9: Run the full web test suite**

Run: `cd packages/web && bun test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/workbench/theme/colors.ts packages/web/src/workbench/theme/colors.test.ts packages/web/src/Editor.tsx packages/web/src/workbench/terminal/theme.ts
git commit -m "refactor(web): dedupe editor/terminal color literals into ZERO_COLORS"
```

---

## Task 9: Update README Status section

**Files:**
- Modify: `README.md:26-32`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the Status section**

In `README.md`, replace the `## Status` section (currently: "Pre-M2. M0 (skeleton: daemon-served browser editor with save) and M1 (offline copilot: Chrome Nano completions with an Ollama-compatible fallback) are implemented. See the roadmap in the design spec for what's next (terminal/LSP, Graphify, chat/AgentRuntime, Zero Agents, Zero Lite, the Claude plugin, Zero IDE).") with:

```markdown
## Status

M0 (skeleton: daemon-served browser editor with save), M1 (offline copilot:
Chrome Nano completions with an Ollama-compatible fallback), and M2
(terminal via PTY, LSP diagnostics/hover/go-to-definition) are implemented.
See the roadmap in the design spec for what's next (Graphify, chat/
AgentRuntime, Zero Agents, Zero Lite, the Claude plugin, Zero IDE).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README status for M2 completion"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite**

Run: `bun test` (from the repo root)
Expected: all packages' tests pass.

- [ ] **Step 2: Run the full typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Run the dev server per the project's existing run instructions. Confirm, in both light and dark theme:
- Command palette (both the command list and Cmd/Ctrl+P file opener) shows a visible keyboard-navigation highlight, uses the FiraCode font, and shows file icons in the file opener.
- File tree shows the new SVG icons instead of emoji.
- Settings dropdown and the status pill are legible in dark mode.
- README's Status section reads correctly (`cat README.md | sed -n '/## Status/,/^## /p'`).
