# File Viewers (Markdown/Image/PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a Markdown/image/PDF file in the Zero workbench shows a
type-appropriate view instead of forcing everything through the CodeMirror
text editor.

**Architecture:** A new `fs/readBinary` RPC (base64 + mime type) is added
to both the daemon and Zero Lite's local RPC, sharing one result shape.
`Workbench.tsx` classifies each opened file by extension and either keeps
the existing text pipeline (Markdown, still editable, now with a rendered
preview alongside it) or renders a new binary-fetching viewer component
(image, PDF) instead of `<Editor>`.

**Tech Stack:** TypeScript strict/ESM, Bun test, React 18, `@zero/protocol`
JSON-RPC, `marked` (new dependency, Markdown → HTML).

**Spec:** `docs/superpowers/specs/2026-08-18-file-viewers-design.md`

## Global Constraints

- `@zero/core` and `@zero/protocol` must never import DOM or Node/Bun APIs.
- All packages: TypeScript `strict: true`, ESM only.
- Every new file/behavior needs a test alongside it (`*.test.ts(x)` next to
  the module), following existing patterns in each package.
- No size cap on binary reads for this change (per spec — revisit later if
  it becomes a real problem).
- `mimeType` is derived from the file extension via a small fixed lookup
  table, not content-sniffed.

---

### Task 1: Daemon — `fs/readBinary` RPC

**Files:**
- Create: `packages/daemon/src/mime.ts`
- Modify: `packages/protocol/src/messages.ts` (add types near `FsReadResult`)
- Modify: `packages/daemon/src/workspace.ts` (add `readBinary` after `read`,
  around line 64)
- Modify: `packages/daemon/src/main.ts` (register the RPC, around line 84
  where `fs/read` is registered)
- Test: `packages/daemon/src/mime.test.ts`
- Test: `packages/daemon/src/workspace.test.ts` (add a case)

**Interfaces:**
- Produces: `mimeTypeFor(path: string): string` (exported from
  `packages/daemon/src/mime.ts`)
- Produces: `Workspace#readBinary(rel: string): Promise<Buffer>`
- Produces: RPC method `fs/readBinary` — params `{ path: string }`, result
  `{ contentBase64: string; mimeType: string }`
- Produces (protocol types, consumed by every later task):
  ```ts
  export interface FsReadBinaryParams { path: string }
  export interface FsReadBinaryResult { contentBase64: string; mimeType: string }
  ```

- [ ] **Step 1: Write the failing mime test**

```ts
// packages/daemon/src/mime.test.ts
import { expect, test } from "bun:test";
import { mimeTypeFor } from "./mime";

test("maps known extensions to mime types", () => {
  expect(mimeTypeFor("a.png")).toBe("image/png");
  expect(mimeTypeFor("a.jpg")).toBe("image/jpeg");
  expect(mimeTypeFor("a.jpeg")).toBe("image/jpeg");
  expect(mimeTypeFor("a.gif")).toBe("image/gif");
  expect(mimeTypeFor("a.svg")).toBe("image/svg+xml");
  expect(mimeTypeFor("a.webp")).toBe("image/webp");
  expect(mimeTypeFor("a.pdf")).toBe("application/pdf");
});

test("falls back to octet-stream for unknown extensions", () => {
  expect(mimeTypeFor("a.bin")).toBe("application/octet-stream");
  expect(mimeTypeFor("noext")).toBe("application/octet-stream");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/daemon/src/mime.test.ts`
Expected: FAIL — `./mime` has no exports (module not found).

- [ ] **Step 3: Implement `mimeTypeFor`**

```ts
// packages/daemon/src/mime.ts
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Derives a mime type from a file's extension via a small fixed table —
 * not content-sniffed, since callers already trust the extension to pick
 * which viewer renders the file. */
export function mimeTypeFor(path: string): string {
  const dotIndex = path.lastIndexOf(".");
  const ext = dotIndex >= 0 ? path.slice(dotIndex + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/daemon/src/mime.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Add the protocol types**

In `packages/protocol/src/messages.ts`, directly below `export interface
FsReadResult { content: string }`:

```ts
export interface FsReadBinaryParams { path: string }
export interface FsReadBinaryResult { contentBase64: string; mimeType: string }
```

- [ ] **Step 6: Write the failing `Workspace.readBinary` test**

Add to `packages/daemon/src/workspace.test.ts` (uses the existing
`makeProject()` helper already in that file):

```ts
test("readBinary round-trips raw bytes as base64", async () => {
  const root = makeProject();
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  writeFileSync(join(root, "img.bin"), bytes);
  const ws = new Workspace(root);
  const buf = await ws.readBinary("img.bin");
  expect(Buffer.from(buf).toString("base64")).toBe(Buffer.from(bytes).toString("base64"));
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test packages/daemon/src/workspace.test.ts`
Expected: FAIL — `ws.readBinary is not a function`

- [ ] **Step 8: Implement `Workspace.readBinary`**

In `packages/daemon/src/workspace.ts`, immediately after the existing
`read` method (line 64):

```ts
async readBinary(rel: string): Promise<Buffer> {
  return fs.readFile(await this.#resolveReal(rel));
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `bun test packages/daemon/src/workspace.test.ts`
Expected: PASS (all cases, including the new one)

- [ ] **Step 10: Register the `fs/readBinary` RPC**

In `packages/daemon/src/main.ts`, add the import and register the method
right after the existing `fs/read` registration (line 84-85):

```ts
import { mimeTypeFor } from "./mime";
```

```ts
daemon.rpc.register("fs/readBinary", z.object({ path: z.string() }),
  async (p) => ({
    contentBase64: (await ws.readBinary(p.path)).toString("base64"),
    mimeType: mimeTypeFor(p.path),
  }));
```

- [ ] **Step 11: Typecheck and run the full daemon test suite**

Run: `bun run typecheck && bun test packages/daemon`
Expected: PASS, no type errors

- [ ] **Step 12: Commit**

```bash
git add packages/protocol/src/messages.ts packages/daemon/src/mime.ts \
  packages/daemon/src/mime.test.ts packages/daemon/src/workspace.ts \
  packages/daemon/src/workspace.test.ts packages/daemon/src/main.ts
git commit -m "feat(daemon): add fs/readBinary RPC for binary file reads"
```

---

### Task 2: Web — `classifyFile` and shared `mimeTypeFor`

**Files:**
- Create: `packages/web/src/workbench/fileKind.ts`
- Test: `packages/web/src/workbench/fileKind.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, string in)
- Produces (consumed by Tasks 3, 6-9):
  - `export type FileKind = "text" | "markdown" | "image" | "pdf"`
  - `export function classifyFile(path: string): FileKind`
  - `export function mimeTypeFor(path: string): string` (same table as the
    daemon's `mime.ts` — duplicated deliberately per spec; `@zero/web`
    can't import `@zero/daemon` and this is a 7-line lookup, not a shared
    protocol shape)

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/workbench/fileKind.test.ts
import { expect, test } from "bun:test";
import { classifyFile, mimeTypeFor } from "./fileKind";

test("classifies markdown files", () => {
  expect(classifyFile("README.md")).toBe("markdown");
  expect(classifyFile("notes.mdx")).toBe("markdown");
});

test("classifies image files", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "svg", "webp"]) {
    expect(classifyFile(`a.${ext}`)).toBe("image");
  }
});

test("classifies pdf files", () => {
  expect(classifyFile("doc.pdf")).toBe("pdf");
});

test("everything else is text, including leading-dot files with no extension", () => {
  expect(classifyFile("index.ts")).toBe("text");
  expect(classifyFile(".gitignore")).toBe("text");
  expect(classifyFile("Makefile")).toBe("text");
});

test("mimeTypeFor mirrors the daemon's table for viewer-relevant extensions", () => {
  expect(mimeTypeFor("a.png")).toBe("image/png");
  expect(mimeTypeFor("a.pdf")).toBe("application/pdf");
  expect(mimeTypeFor("a.svg")).toBe("image/svg+xml");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/fileKind.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `fileKind.ts`**

```ts
// packages/web/src/workbench/fileKind.ts
export type FileKind = "text" | "markdown" | "image" | "pdf";

const MARKDOWN_EXTS = new Set(["md", "mdx"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
};

/** Leading-dot files like ".gitignore" have no extension by this rule
 * (mirrors `iconFor.ts`'s existing convention) and are always "text". */
function extOf(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : "";
}

export function classifyFile(path: string): FileKind {
  const ext = extOf(path);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "text";
}

export function mimeTypeFor(path: string): string {
  return MIME_BY_EXT[extOf(path)] ?? "application/octet-stream";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/web/src/workbench/fileKind.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/fileKind.ts packages/web/src/workbench/fileKind.test.ts
git commit -m "feat(web): add classifyFile/mimeTypeFor for viewer routing"
```

---

### Task 3: Zero Lite — `fs/readBinary` support

**Files:**
- Modify: `packages/web/src/lite/browserFs.ts` (`FileHandle` interface +
  `BrowserFSWorkspace.readBinary`)
- Modify: `packages/web/src/lite/memDir.ts` (`MemFile.arrayBuffer`)
- Modify: `packages/web/src/lite/localRpc.ts` (`LocalRpcOpts.fs` +
  `fs/readBinary` case)
- Test: `packages/web/src/lite/browserFs.test.ts` (add a case)
- Test: `packages/web/src/lite/localRpc.test.ts` (add a case)

**Interfaces:**
- Consumes: `mimeTypeFor` from `../workbench/fileKind` (Task 2)
- Produces: `BrowserFSWorkspace#readBinary(path: string): Promise<{
  base64: string; mimeType: string }>`, wired into `createLocalSocket`'s
  `fs/readBinary` case — same `{ contentBase64, mimeType }` shape Task 1's
  daemon RPC returns, so viewer components (Tasks 7-8) don't need to know
  which flavour they're talking to.

- [ ] **Step 1: Write the failing `browserFs` test**

Add to `packages/web/src/lite/browserFs.test.ts`, reusing the file's
existing `seeded()` helper:

```ts
test("readBinary round-trips bytes as base64 with the right mime type", async () => {
  const ws = await seeded();
  // MemFile only stores text (see memDir.ts), so round-trip via a string
  // that maps 1:1 through btoa/atob — this test only needs to prove
  // readBinary reaches the file and returns {base64, mimeType}, not that
  // MemFile stores real binary (Step 3 below extends MemFile itself).
  await ws.write("src/pic.png", "fake-bytes");
  const result = await ws.readBinary("src/pic.png");
  expect(result.mimeType).toBe("image/png");
  expect(atob(result.base64)).toBe("fake-bytes");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/lite/browserFs.test.ts`
Expected: FAIL — `ws.readBinary is not a function`

- [ ] **Step 3: Extend `FileHandle` and `MemFile` with `arrayBuffer`**

In `packages/web/src/lite/browserFs.ts`, change the `FileHandle`
interface's `getFile()` return type (line 14) to add `arrayBuffer`:

```ts
export interface FileHandle {
  name: string;
  kind: "file";
  getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; size: number }>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
```

In `packages/web/src/lite/memDir.ts`, extend `MemFile.getFile()` (line 21)
to match:

```ts
async getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; size: number }> {
  return {
    text: async () => this.content,
    arrayBuffer: async () => new TextEncoder().encode(this.content).buffer,
    size: this.content.length,
  };
}
```

(A real browser `File`/`Blob` already implements `arrayBuffer()` — this
change only affects the interface contract and the in-memory test double.)

- [ ] **Step 4: Implement `BrowserFSWorkspace.readBinary`**

In `packages/web/src/lite/browserFs.ts`, add the import and method right
after `read` (line 74):

```ts
import { mimeTypeFor } from "../workbench/fileKind";
```

```ts
async readBinary(path: string): Promise<{ base64: string; mimeType: string }> {
  const { parent, name } = await this.#parentAndName(path, false);
  const file = await parent.getFileHandle(name);
  const buf = await (await file.getFile()).arrayBuffer();
  let binary = "";
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte);
  return { base64: btoa(binary), mimeType: mimeTypeFor(path) };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test packages/web/src/lite/browserFs.test.ts`
Expected: PASS (all cases, including the new one)

- [ ] **Step 6: Write the failing `localRpc` test**

Add to `packages/web/src/lite/localRpc.test.ts` (check the existing file
first for its fake-`opts.fs` shape and reuse it, adding a `readBinary`
stub):

```ts
test("fs/readBinary dispatches to opts.fs.readBinary and returns its result", async () => {
  const fs = {
    read: async () => "",
    write: async () => {},
    tree: async () => [],
    search: async () => ({ matches: [], truncated: false }),
    create: async () => {},
    rename: async () => {},
    delete: async () => {},
    move: async () => {},
    copy: async () => {},
    readBinary: async (path: string) => ({ base64: "Zm9v", mimeType: "image/png" }),
  };
  const socket = createLocalSocket({ workspaceName: "w", fs });
  const result = await new Promise((resolve) => {
    socket.onmessage = (raw) => resolve(JSON.parse(raw));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fs/readBinary", params: { path: "a.png" } }));
  });
  expect((result as any).result).toEqual({ contentBase64: "Zm9v", mimeType: "image/png" });
});
```

Adjust the exact fake shape to match whatever helper the existing test
file already uses for `opts.fs` (don't duplicate a second fake builder if
one exists there).

- [ ] **Step 7: Run it to verify it fails**

Run: `bun test packages/web/src/lite/localRpc.test.ts`
Expected: FAIL — `fs/readBinary` hits `MethodNotAvailable` (no `extra`
handler configured), or a type error if `readBinary` isn't yet on
`LocalRpcOpts.fs`.

- [ ] **Step 8: Wire `fs/readBinary` into `localRpc.ts`**

In `packages/web/src/lite/localRpc.ts`, add `readBinary` to the `fs`
interface (line 11-21):

```ts
readBinary(path: string): Promise<{ base64: string; mimeType: string }>;
```

Add a case in `dispatch` (line 77), next to `fs/read`:

```ts
case "fs/readBinary": {
  const { base64, mimeType } = await opts.fs.readBinary(str(params, "path"));
  return { contentBase64: base64, mimeType };
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `bun test packages/web/src/lite/localRpc.test.ts`
Expected: PASS

- [ ] **Step 10: Typecheck the whole repo**

`BrowserFSWorkspace` is passed directly as `fs: workspace` to
`createLocalSocket` in `connection.ts` — confirm it now structurally
satisfies the extended `LocalRpcOpts["fs"]`.

Run: `bun run typecheck`
Expected: PASS, no type errors

- [ ] **Step 11: Commit**

```bash
git add packages/web/src/lite/browserFs.ts packages/web/src/lite/browserFs.test.ts \
  packages/web/src/lite/memDir.ts packages/web/src/lite/localRpc.ts \
  packages/web/src/lite/localRpc.test.ts
git commit -m "feat(web/lite): add fs/readBinary to the local RPC socket"
```

---

### Task 4: Shared binary-fetch helper for viewers

**Files:**
- Create: `packages/web/src/workbench/viewers/fetchBinary.ts`
- Test: `packages/web/src/workbench/viewers/fetchBinary.test.ts`

**Interfaces:**
- Consumes: `RpcClient` from `@zero/protocol`, `FsReadBinaryResult` (Task 1)
- Produces (consumed by Tasks 6, 7):
  - `export function fetchBinaryFile(client: RpcClient, path: string): Promise<FsReadBinaryResult>`
  - `export function base64ToDataUrl(base64: string, mimeType: string): string`
  - `export function base64ToObjectUrl(base64: string, mimeType: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/src/workbench/viewers/fetchBinary.test.ts
import { expect, test } from "bun:test";
import type { RpcClient } from "@zero/protocol";
import { fetchBinaryFile, base64ToDataUrl, base64ToObjectUrl } from "./fetchBinary";

test("fetchBinaryFile requests fs/readBinary with the given path", async () => {
  let seenMethod = "";
  let seenParams: unknown;
  const client = {
    request: async (method: string, params: unknown) => {
      seenMethod = method;
      seenParams = params;
      return { contentBase64: "Zm9v", mimeType: "image/png" };
    },
  } as unknown as RpcClient;
  const result = await fetchBinaryFile(client, "a.png");
  expect(seenMethod).toBe("fs/readBinary");
  expect(seenParams).toEqual({ path: "a.png" });
  expect(result).toEqual({ contentBase64: "Zm9v", mimeType: "image/png" });
});

test("base64ToDataUrl builds a data: URL", () => {
  expect(base64ToDataUrl("Zm9v", "image/png")).toBe("data:image/png;base64,Zm9v");
});

test("base64ToObjectUrl builds a blob: URL via URL.createObjectURL", () => {
  const url = base64ToObjectUrl("Zm9v", "application/pdf");
  expect(url.startsWith("blob:")).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/viewers/fetchBinary.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `fetchBinary.ts`**

```ts
// packages/web/src/workbench/viewers/fetchBinary.ts
import type { RpcClient, FsReadBinaryResult } from "@zero/protocol";

export function fetchBinaryFile(client: RpcClient, path: string): Promise<FsReadBinaryResult> {
  return client.request<FsReadBinaryResult>("fs/readBinary", { path });
}

export function base64ToDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** Blob URLs have no practical size cap (unlike data: URLs, which some
 * browsers cap around 2MB for `<embed>`/`<iframe>`) — used for the PDF
 * viewer, which embeds via `<embed>`. Callers must revoke the returned URL
 * (`URL.revokeObjectURL`) when done with it. */
export function base64ToObjectUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/web/src/workbench/viewers/fetchBinary.test.ts`
Expected: PASS (all three tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/viewers/fetchBinary.ts packages/web/src/workbench/viewers/fetchBinary.test.ts
git commit -m "feat(web): add fetchBinaryFile helper shared by image/pdf viewers"
```

---

### Task 5: Add `marked` dependency

**Files:**
- Modify: `packages/web/package.json`

**Interfaces:**
- Produces: `marked` importable as `import { marked } from "marked"` in
  Task 6.

- [ ] **Step 1: Add the dependency**

Run: `bun add marked --cwd packages/web`

- [ ] **Step 2: Verify it installed and the lockfile updated**

Run: `grep '"marked"' packages/web/package.json && git status --short bun.lock packages/web/package.json`
Expected: `marked` present in `dependencies`; `bun.lock` shows as modified.

- [ ] **Step 3: Commit**

```bash
git add packages/web/package.json bun.lock
git commit -m "chore(web): add marked for Markdown preview rendering"
```

---

### Task 6: `MarkdownPreview` component

**Files:**
- Create: `packages/web/src/workbench/viewers/MarkdownPreview.tsx`
- Test: `packages/web/src/workbench/viewers/MarkdownPreview.test.tsx`

**Interfaces:**
- Consumes: `marked` (Task 5)
- Produces (consumed by Task 9):
  `export function MarkdownPreview(props: { content: string }): JSX.Element`
  and the pure helper `export function renderMarkdown(content: string): string`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/workbench/viewers/MarkdownPreview.test.tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview, renderMarkdown } from "./MarkdownPreview";

test("renderMarkdown converts headings and emphasis to HTML", () => {
  const html = renderMarkdown("# Title\n\nSome **bold** text.");
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>bold</strong>");
});

test("MarkdownPreview renders the converted HTML into the DOM", () => {
  const html = renderToStaticMarkup(<MarkdownPreview content="# Hi" />);
  expect(html).toContain("<h1>Hi</h1>");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/viewers/MarkdownPreview.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `MarkdownPreview.tsx`**

```tsx
// packages/web/src/workbench/viewers/MarkdownPreview.tsx
import { marked } from "marked";

export function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}

// Content rendered here is always a file already open in the user's own
// workspace, not third-party/untrusted web content — the same trust level
// as opening it for editing — so dangerouslySetInnerHTML on marked's
// output is acceptable without a separate sanitizer pass.
export function MarkdownPreview(props: { content: string }) {
  return (
    <div
      className="zero-markdown-preview"
      style={{ height: "100%", overflow: "auto", padding: "12px 16px" }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(props.content) }}
    />
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/web/src/workbench/viewers/MarkdownPreview.test.tsx`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/viewers/MarkdownPreview.tsx packages/web/src/workbench/viewers/MarkdownPreview.test.tsx
git commit -m "feat(web): add MarkdownPreview component"
```

---

### Task 7: `ImageViewer` component

**Files:**
- Create: `packages/web/src/workbench/viewers/ImageViewer.tsx`
- Test: `packages/web/src/workbench/viewers/ImageViewer.test.tsx`

**Interfaces:**
- Consumes: `fetchBinaryFile`, `base64ToDataUrl` (Task 4)
- Produces (consumed by Task 9):
  `export function ImageViewer(props: { path: string; client: RpcClient }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Effects don't run under `renderToStaticMarkup` (confirmed by the existing
`Workbench.test.tsx` pattern), so this test only covers the initial
"loading" render — the fetch-then-render behavior is already covered by
Task 4's `fetchBinaryFile`/`base64ToDataUrl` unit tests, which `ImageViewer`
composes directly in its effect.

```tsx
// packages/web/src/workbench/viewers/ImageViewer.test.tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { ImageViewer } from "./ImageViewer";

const fakeClient = { request: () => Promise.reject(new Error("not called")) } as unknown as RpcClient;

test("shows a loading state before the fetch resolves", () => {
  const html = renderToStaticMarkup(<ImageViewer path="a.png" client={fakeClient} />);
  expect(html).toContain("Loading");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/viewers/ImageViewer.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `ImageViewer.tsx`**

```tsx
// packages/web/src/workbench/viewers/ImageViewer.tsx
import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { fetchBinaryFile, base64ToDataUrl } from "./fetchBinary";

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function ImageViewer(props: { path: string; client: RpcClient }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; dataUrl: string }>({ status: "loading" });
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    setState({ status: "loading" });
    setZoom(1);
    let cancelled = false;
    fetchBinaryFile(props.client, props.path)
      .then(({ contentBase64, mimeType }) => {
        if (cancelled) return;
        setState({ status: "ready", dataUrl: base64ToDataUrl(contentBase64, mimeType) });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [props.client, props.path]);

  if (state.status === "loading") return <div style={{ padding: 16, opacity: 0.6 }}>Loading image…</div>;
  if (state.status === "error") return <div style={{ padding: 16, color: "var(--zero-error, #e5484d)" }}>Could not load image: {state.message}</div>;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 8, padding: "4px 8px" }}>
        <button onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))} aria-label="Zoom in">+</button>
        <button onClick={() => setZoom(1)} aria-label="Reset zoom">Fit</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", alignItems: zoom <= 1 ? "center" : "flex-start", justifyContent: zoom <= 1 ? "center" : "flex-start" }}>
        <img
          src={state.dataUrl}
          alt={props.path}
          style={zoom <= 1 ? { maxWidth: "100%", maxHeight: "100%" } : { width: `${zoom * 100}%` }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/web/src/workbench/viewers/ImageViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/viewers/ImageViewer.tsx packages/web/src/workbench/viewers/ImageViewer.test.tsx
git commit -m "feat(web): add ImageViewer component"
```

---

### Task 8: `PdfViewer` component

**Files:**
- Create: `packages/web/src/workbench/viewers/PdfViewer.tsx`
- Test: `packages/web/src/workbench/viewers/PdfViewer.test.tsx`

**Interfaces:**
- Consumes: `fetchBinaryFile`, `base64ToObjectUrl` (Task 4)
- Produces (consumed by Task 9):
  `export function PdfViewer(props: { path: string; client: RpcClient }): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/workbench/viewers/PdfViewer.test.tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { PdfViewer } from "./PdfViewer";

const fakeClient = { request: () => Promise.reject(new Error("not called")) } as unknown as RpcClient;

test("shows a loading state before the fetch resolves", () => {
  const html = renderToStaticMarkup(<PdfViewer path="a.pdf" client={fakeClient} />);
  expect(html).toContain("Loading");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/viewers/PdfViewer.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `PdfViewer.tsx`**

```tsx
// packages/web/src/workbench/viewers/PdfViewer.tsx
import { useEffect, useState } from "react";
import type { RpcClient } from "@zero/protocol";
import { fetchBinaryFile, base64ToObjectUrl } from "./fetchBinary";

export function PdfViewer(props: { path: string; client: RpcClient }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; objectUrl: string }>({ status: "loading" });

  useEffect(() => {
    setState({ status: "loading" });
    let cancelled = false;
    let createdUrl: string | undefined;
    fetchBinaryFile(props.client, props.path)
      .then(({ contentBase64, mimeType }) => {
        if (cancelled) return;
        createdUrl = base64ToObjectUrl(contentBase64, mimeType);
        setState({ status: "ready", objectUrl: createdUrl });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      // Revoke on unmount/path-change to avoid leaking a blob per tab switch.
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [props.client, props.path]);

  if (state.status === "loading") return <div style={{ padding: 16, opacity: 0.6 }}>Loading PDF…</div>;
  if (state.status === "error") return <div style={{ padding: 16, color: "var(--zero-error, #e5484d)" }}>Could not load PDF: {state.message}</div>;

  return <embed src={state.objectUrl} type="application/pdf" style={{ width: "100%", height: "100%", border: "none" }} />;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/web/src/workbench/viewers/PdfViewer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/workbench/viewers/PdfViewer.tsx packages/web/src/workbench/viewers/PdfViewer.test.tsx
git commit -m "feat(web): add PdfViewer component"
```

---

### Task 9: Wire viewers into `Workbench.tsx`

**Files:**
- Modify: `packages/web/src/workbench/layout/Workbench.tsx`
  - `openFile` (currently lines 732-743)
  - `EditorPanel` (currently lines 239-287)
  - the `lsp/sync` debounce effect (currently lines 701-730)
- Test: `packages/web/src/workbench/layout/Workbench.test.tsx` (add cases)

**Interfaces:**
- Consumes: `classifyFile` (Task 2), `MarkdownPreview` (Task 6),
  `ImageViewer` (Task 7), `PdfViewer` (Task 8)
- Produces: nothing further downstream — this is the integration point.

- [ ] **Step 1: Write the failing tests**

`Workbench.test.tsx` already exports/imports enough scaffolding
(`WorkbenchContext`, a `fakeClient`) to test `EditorPanel` the same way
`BottomPanel` is tested above it in the same file. Add:

```tsx
// Additions to packages/web/src/workbench/layout/Workbench.test.tsx
import { EditorPanel } from "./Workbench"; // will need exporting — see Step 2
import { TabStore } from "../tabs/store";

function renderEditorPanel(path: string) {
  const tabStore = new TabStore();
  tabStore.openFile("group-1", path, "# hello");
  const contextValue = {
    client: fakeClient,
    tabStore,
    theme: "dark" as const,
    diagnosticsByPath: new Map(),
    setActiveGroupId: () => {},
    setCursor: () => {},
    registerView: () => {},
    requestCompletion: () => {},
    capabilities: ALL_CAPABILITIES,
    openFile: () => {},
  };
  return renderToStaticMarkup(
    <WorkbenchContext.Provider value={contextValue as any}>
      <EditorPanel params={{ groupId: "group-1" }} api={{} as any} containerApi={{} as any} />
    </WorkbenchContext.Provider>,
  );
}

describe("EditorPanel viewer routing", () => {
  test("renders the CodeMirror host for a .ts file", () => {
    const html = renderEditorPanel("a.ts");
    expect(html).not.toContain("zero-markdown-preview");
  });

  test("renders a markdown split with a live preview for a .md file", () => {
    const html = renderEditorPanel("a.md");
    expect(html).toContain("zero-markdown-preview");
    expect(html).toContain("<h1>hello</h1>");
  });

  test("renders ImageViewer (loading state) for a .png file, skipping CodeMirror", () => {
    const html = renderEditorPanel("a.png");
    expect(html).toContain("Loading image");
  });

  test("renders PdfViewer (loading state) for a .pdf file, skipping CodeMirror", () => {
    const html = renderEditorPanel("a.pdf");
    expect(html).toContain("Loading PDF");
  });
});
```

Adjust `IDockviewPanelProps`-shaped test props (`api`, `containerApi`) to
match whatever the file's actual `EditorPanel` signature requires — check
the current definition (`function EditorPanel(props:
IDockviewPanelProps<{ groupId: string }>)`) and pass the minimal fields
`renderToStaticMarkup` needs; dockview panel props beyond `params` aren't
read by the component today.

Also add a focused test for the `openFile` binary-skip decision. Rather
than driving the full `openFile` closure (which needs a live `client` and
`tabStore` wired through component state), export a tiny decision
function from `Workbench.tsx` next to `getBottomPanelAction` — same
pattern already used in this file for testable decision points — and unit
test that directly:

```ts
export function isBinaryFileKind(path: string): boolean {
  const kind = classifyFile(path);
  return kind === "image" || kind === "pdf";
}
```

and test that directly:

```tsx
test("isBinaryFileKind is true only for image/pdf paths", () => {
  expect(isBinaryFileKind("a.png")).toBe(true);
  expect(isBinaryFileKind("a.pdf")).toBe(true);
  expect(isBinaryFileKind("a.md")).toBe(false);
  expect(isBinaryFileKind("a.ts")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/web/src/workbench/layout/Workbench.test.tsx`
Expected: FAIL — `EditorPanel` not exported, `isBinaryFileKind` not defined,
markdown/image/pdf routing not implemented yet.

- [ ] **Step 3: Import the new pieces and export `EditorPanel`/`isBinaryFileKind`**

In `Workbench.tsx`, add imports near the top (alongside the existing
`Editor` import at line 5):

```ts
import { classifyFile } from "../fileKind";
import { MarkdownPreview } from "../viewers/MarkdownPreview";
import { ImageViewer } from "../viewers/ImageViewer";
import { PdfViewer } from "../viewers/PdfViewer";
```

Add the exported decision helper near `getBottomPanelAction` (around
line 49-57):

```ts
export function isBinaryFileKind(path: string): boolean {
  const kind = classifyFile(path);
  return kind === "image" || kind === "pdf";
}
```

Change `function EditorPanel(...)` (line 239) to `export function
EditorPanel(...)`.

- [ ] **Step 4: Branch `openFile` on `isBinaryFileKind`**

Replace the body of `openFile` (lines 732-743):

```ts
function openFile(path: string): void {
  const groupId = tabStore.getGroups().some((g) => g.id === activeGroupIdRef.current)
    ? activeGroupIdRef.current
    : tabStore.getGroups()[0]!.id;
  if (isBinaryFileKind(path)) {
    tabStore.openFile(groupId, path, "");
    setActiveGroupId(groupId);
    return;
  }
  void client
    .request<FsReadResult>("fs/read", { path })
    .then((res) => {
      tabStore.openFile(groupId, path, res.content);
      setActiveGroupId(groupId);
    })
    .catch((e: unknown) => reportRef.current(`Could not open ${path}: ${errorText(e)}`));
}
```

- [ ] **Step 5: Switch `EditorPanel`'s render on `classifyFile`**

Replace the `{tab ? (<Editor .../>) : (...)}` block inside `EditorPanel`
(lines 253-283) with:

```tsx
{tab ? (
  classifyFile(tab.path) === "markdown" ? (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <div style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--zero-border, #333)" }}>
        <Editor
          path={tab.path}
          content={tab.content}
          theme={w.theme}
          onSave={(text) => { w.tabStore.updateContent(tab.id, text); w.saveTab(tab.id); }}
          onChange={(text) => w.tabStore.updateContent(tab.id, text)}
          onCursorChange={(pos) => { if (groupId === w.activeGroupId) w.setCursor(pos); }}
          requestCompletion={w.requestCompletion}
          onViewChange={(view) => w.registerView(groupId, view)}
          diagnostics={w.diagnosticsByPath.get(tab.path) ?? []}
          client={w.client}
          lspEnabled={w.capabilities.lsp}
          onGoToDefinition={(path, line, character) => { w.openFile(path); }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <MarkdownPreview content={tab.content} />
      </div>
    </div>
  ) : classifyFile(tab.path) === "image" ? (
    <ImageViewer path={tab.path} client={w.client} />
  ) : classifyFile(tab.path) === "pdf" ? (
    <PdfViewer path={tab.path} client={w.client} />
  ) : (
    <Editor
      path={tab.path}
      content={tab.content}
      theme={w.theme}
      onSave={(text) => { w.tabStore.updateContent(tab.id, text); w.saveTab(tab.id); }}
      onChange={(text) => w.tabStore.updateContent(tab.id, text)}
      onCursorChange={(pos) => { if (groupId === w.activeGroupId) w.setCursor(pos); }}
      requestCompletion={w.requestCompletion}
      onViewChange={(view) => w.registerView(groupId, view)}
      diagnostics={w.diagnosticsByPath.get(tab.path) ?? []}
      client={w.client}
      lspEnabled={w.capabilities.lsp}
      onGoToDefinition={(path, line, character) => { w.openFile(path); }}
    />
  )
) : (
  <div style={{ padding: 16, opacity: 0.6 }}>Select a file to edit (Cmd/Ctrl+P)</div>
)}
```

(Keep the existing `onGoToDefinition` comment from the original code in
place — omitted above only for brevity in this plan; carry it over
verbatim when editing.)

- [ ] **Step 6: Guard the `lsp/sync` effect against binary tabs**

In the `lsp/sync` debounce effect (line 701-730), change the early return
at the top of the effect body:

```ts
useEffect(() => {
  if (!capabilities.lsp) return;
  if (!activeTab) return;
  if (isBinaryFileKind(activeTab.path)) return;
  clearTimeout(lspSyncDebounceRef.current);
  // ...unchanged...
```

- [ ] **Step 7: Run the full web test suite**

Run: `bun test packages/web`
Expected: PASS, including all 4 new `EditorPanel` cases and the
`isBinaryFileKind` case.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: PASS, no type errors

- [ ] **Step 9: Manually verify in the running app**

```bash
bun run --cwd packages/daemon build 2>/dev/null || true
bun run --cwd packages/web build
zero serve .
```

Open the served URL, open a `.md` file (confirm split source+preview),
a `.png`/`.svg` file (confirm zoom controls and image render), and a
`.pdf` file (confirm it renders via the browser's PDF viewer). Confirm a
`.ts` file still behaves exactly as before (editable, saveable, LSP
hover/diagnostics working).

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/workbench/layout/Workbench.tsx packages/web/src/workbench/layout/Workbench.test.tsx
git commit -m "feat(web): route markdown/image/pdf tabs to dedicated viewers"
```

---

## Self-Review Notes

- **Spec coverage:** protocol/daemon binary RPC (Task 1), Lite binary RPC
  (Task 3), file-type classification (Task 2), Markdown split preview
  (Tasks 5-6, wired in Task 9), image viewer (Task 7), PDF viewer
  (Task 8), LSP-sync guard (Task 9 Step 6), tests for every new module —
  all covered.
- **Type consistency:** `FsReadBinaryResult { contentBase64, mimeType }`
  is the one shape used end-to-end — daemon (Task 1), Lite (Task 3),
  `fetchBinaryFile`'s return type (Task 4), and both viewers (Tasks 7-8)
  all reference it identically.
- **No placeholders:** every step has real code. The two spots in Task 9
  that ask the implementer to check exact current line numbers/signatures
  (dockview panel props, the `onGoToDefinition` comment) do so because
  those exist in the file today and must be read, not invented — this is
  scoped, not vague.
