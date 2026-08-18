# File viewers: Markdown, image, PDF

Adds type-appropriate viewing for non-code files opened in the Zero
workbench, which today force every file through the CodeMirror text editor
regardless of content.

## Motivation

Opening a `.png`, `.pdf`, or `.md` file currently either garbles binary
content (CodeMirror renders whatever `fs/read`'s UTF-8 decode produced) or,
for Markdown, shows raw source with no rendered view. This adds:

- A Markdown split view: source editor + live rendered preview.
- An image viewer: zoom/pan/fit for PNG/JPG/JPEG/GIF/SVG/WebP.
- A PDF viewer: browser-native rendering (Chrome/Edge's built-in viewer,
  or an installed Adobe Acrobat extension transparently taking over — no
  extension-detection code needed since this is standard MIME-type embed
  behavior).

## Non-goals

- Image editing (crop/annotate/adjust) — viewer only.
- A draggable/resizable Markdown split — fixed 50/50 for now.
- Any change to how text/code files are opened, edited, or saved.

## Protocol: binary file reads

`fs/read` returns `{ content: string }` via UTF-8 decode and cannot
represent binary data. Add a sibling RPC rather than overloading it:

```ts
// packages/protocol/src/messages.ts
export interface FsReadBinaryParams { path: string }
export interface FsReadBinaryResult { contentBase64: string; mimeType: string }
```

`mimeType` is derived server-side from the file extension (small fixed
lookup: png/jpg/jpeg/gif/svg/webp/pdf), not sniffed from content — the
routing that picks which viewer to use already trusts the extension (see
`classifyFile` below), so the mime type just needs to agree with it.

### Daemon (`packages/daemon`)

`Workspace.read` uses `fs.readFile(path, "utf8")`. Add:

```ts
// workspace.ts
async readBinary(rel: string): Promise<Buffer> {
  return fs.readFile(await this.#resolveReal(rel));
}
```

Register in `main.ts`:

```ts
daemon.rpc.register("fs/readBinary", z.object({ path: z.string() }),
  async (p) => ({
    contentBase64: (await ws.readBinary(p.path)).toString("base64"),
    mimeType: mimeTypeFor(p.path),
  }));
```

`mimeTypeFor` is a small new helper (e.g. `packages/daemon/src/mime.ts`),
reused by the Lite implementation below by duplicating the same fixed
table client-side (no shared package boundary crossing for six lines of
lookup — `@zero/protocol` and `@zero/core` stay DOM/Node-free per the
project constraint, and this is presentation metadata, not protocol
shape).

### Zero Lite (`packages/web/src/lite`)

`browserFs.ts`'s `read` uses `file.getFile()` then `.text()`. Add:

```ts
async readBinary(path: string): Promise<{ base64: string; mimeType: string }> {
  const { parent, name } = await this.#resolveParent(path);
  const file = await parent.getFileHandle(name);
  const buf = await (await file.getFile()).arrayBuffer();
  return { base64: base64FromArrayBuffer(buf), mimeType: mimeTypeFor(path) };
}
```

`localRpc.ts` gets a matching `case "fs/readBinary":` alongside the
existing `case "fs/read":`, returning `{ contentBase64, mimeType }` — same
shape the daemon returns, so viewer components make one RPC call
regardless of flavour.

Size: no explicit cap for this change. Base64 inflates by ~33%; workbench
files (icons, screenshots, PDFs) are small enough in practice that adding
a cap is premature — revisit if it becomes a real problem.

## File-type routing

New `packages/web/src/workbench/fileKind.ts`:

```ts
export type FileKind = "text" | "markdown" | "image" | "pdf";
export function classifyFile(path: string): FileKind { ... }
```

Extension-based, mirroring `iconFor.ts`'s existing pattern:
`md`/`mdx` → `markdown`; `png`/`jpg`/`jpeg`/`gif`/`svg`/`webp` → `image`;
`pdf` → `pdf`; everything else → `text`.

## Workbench integration

`Workbench.tsx`'s `openFile` currently always does `fs/read` →
`tabStore.openFile(groupId, path, res.content)`. Branch on
`classifyFile(path)`:

- `text` / `markdown`: unchanged — `fs/read`, opens a normal editable tab.
  (Markdown stays fully readable/editable/saveable through the existing
  text pipeline; only *rendering* changes.)
- `image` / `pdf`: skip `fs/read`; call `tabStore.openFile(groupId, path,
  "")` directly. `TabStore` needs no changes — `content` stays `""`,
  `updateContent` is never called on these tabs, so `dirty` is always
  `false`. Save/close-confirmation logic is untouched and simply never
  triggers for these tabs.

`EditorPanel` (`Workbench.tsx`) currently always renders `<Editor>`.
Switch on `classifyFile(tab.path)`:

- `text`: `<Editor>` as today.
- `markdown`: a 50/50 flex split — `<Editor>` (left) + `<MarkdownPreview
  content={tab.content}>` (right). Both read `tab.content`; the preview
  re-renders on every `onChange` the same way the editor already does.
- `image`: `<ImageViewer path={tab.path} client={w.client}>`.
- `pdf`: `<PdfViewer path={tab.path} client={w.client}>`.

## New components (`packages/web/src/workbench/viewers/`)

**`MarkdownPreview.tsx`** — pure function of `content: string`, no RPC.
Renders via `marked` (new dependency: zero-dependency, small, no DOM
sanitizer built in). Since previewed content is always a file already
open in the user's own workspace — not third-party/untrusted web
content — `dangerouslySetInnerHTML` on `marked`'s output is acceptable
here, consistent with the trust level of local files opened for editing.

**`ImageViewer.tsx`** — on mount, `client.request("fs/readBinary",
{path})`, builds `data:${mimeType};base64,${contentBase64}` and renders
an `<img>`. Fit-to-pane by default (`max-width/max-height: 100%`), with
zoom in/out buttons and a reset-to-fit button; panning via native
scroll when zoomed past fit. Loading and error (failed RPC) states shown
inline, matching the "degrade the failing subsystem, never break editing"
project convention.

**`PdfViewer.tsx`** — same fetch, but builds a `Blob([bytes], {type:
"application/pdf"})` and `URL.createObjectURL` (base64 data URLs are
capped at ~2MB in some browsers for `<embed>`/`<iframe>`; a blob URL has
no such cap). Renders `<embed src={blobUrl} type="application/pdf"
style={{width: "100%", height: "100%"}}>`. Revokes the object URL on
unmount/path change to avoid leaking memory across tab switches.

Both viewers key their fetch effect on `path`, matching `Editor`'s own
per-file-identity pattern.

## Scope guard: LSP sync

`Workbench.tsx`'s `lsp/sync` debounce effect fires on `activeTab.content`
changes whenever `capabilities.lsp` and `activeTab` exist. For an
image/pdf tab, `content` is always `""` and never changes, but the effect
still fires once per file switch, syncing an empty buffer for a path the
language server has no reason to know about. Add a
`classifyFile(activeTab.path) === "text" || classifyFile(...) ===
"markdown"` guard so binary tabs never trigger an `lsp/sync` call.

## Testing

- `fileKind.test.ts` — extension → kind mapping, including edge cases
  (`iconFor.ts` already establishes the leading-dot-file convention;
  reuse it).
- `workspace.test.ts` (daemon) — `readBinary` round-trips a known byte
  sequence back as correct base64.
- `browserFs.test.ts` (lite) — same round-trip via the fake
  `FileSystemFileHandle`.
- `MarkdownPreview.test.tsx` — renders expected HTML for representative
  Markdown input.
- `ImageViewer.test.tsx` / `PdfViewer.test.tsx` — fetch-then-render with a
  fake `RpcClient`, and the error path when the RPC rejects.
- `Workbench.test.tsx` — `openFile` skips `fs/read` for an image path;
  `EditorPanel` renders the right component per `classifyFile` result.

## Out of scope for follow-up

None identified — this is a self-contained addition to the existing
workbench tab/editor pipeline.
