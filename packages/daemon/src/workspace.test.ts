import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, PathOutsideWorkspaceError } from "./workspace";
import { useTempZeroHome } from "./testSupport/zeroHome";
import { settingsPath } from "./paths";

useTempZeroHome();

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "junk.js"), "x");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  return root;
}

test("read and write round-trip", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("b.ts", "hi");
  expect(await ws.read("b.ts")).toBe("hi");
});

test("readBinary round-trips raw bytes as base64", async () => {
  const root = makeProject();
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
  writeFileSync(join(root, "img.bin"), bytes);
  const ws = new Workspace(root);
  const buf = await ws.readBinary("img.bin");
  expect(Buffer.from(buf).toString("base64")).toBe(Buffer.from(bytes).toString("base64"));
});

test("blocks path traversal", async () => {
  const ws = new Workspace(makeProject());
  await expect(ws.read("../../etc/passwd")).rejects.toThrow(PathOutsideWorkspaceError);
  await expect(ws.write("/etc/x", "no")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("tree honors gitignore and skips .git", async () => {
  const ws = new Workspace(makeProject());
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths).toContain("a.ts");
  expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
  expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
});

test("blocks symlink escape for read and write", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  const ws = new Workspace(root);
  await expect(ws.read("link.txt")).rejects.toThrow(PathOutsideWorkspaceError);
  await expect(ws.write("link.txt", "pwned")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("blocks writes through a not-yet-existing path behind a symlinked directory", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  const ws = new Workspace(root);
  await expect(ws.write("outdir/new.txt", "pwned")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("tree honors a nested .gitignore, scoped to its own directory", async () => {
  const root = makeProject();
  mkdirSync(join(root, "pkg", "src-tauri"), { recursive: true });
  writeFileSync(join(root, "pkg", "src-tauri", ".gitignore"), "/target/\n");
  mkdirSync(join(root, "pkg", "src-tauri", "target"));
  writeFileSync(join(root, "pkg", "src-tauri", "target", "bin"), "\x00\x01binary");
  // A same-named "target" directory outside the nested .gitignore's scope
  // must NOT be caught by the scoped pattern.
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target", "keep.txt"), "kept");

  const ws = new Workspace(root);
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths.some((p) => p.startsWith("pkg/src-tauri/target"))).toBe(false);
  expect(paths).toContain("target/keep.txt");
});

test("tree skips symlinks", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  writeFileSync(join(root, "link.txt"), "x"); // placeholder so symlinkSync below targets a real file
  symlinkSync(join(root, "link.txt"), join(root, "linkfile.txt"));
  const ws = new Workspace(root);
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths).not.toContain("outdir");
  expect(paths).not.toContain("linkfile.txt");
});

test("watch reports changes", async () => {
  const ws = new Workspace(makeProject());
  let onChange: (relPath: string) => void = () => {};
  const unsub = ws.watch((relPath) => onChange(relPath));
  // Let the watcher settle before arming the assertion. Recursive fs.watch
  // backends (e.g. FSEvents on macOS) can deliver a backlogged event for
  // files written just before the watcher was created; any such event
  // fires into the no-op callback above and is discarded here, so it can't
  // race with (or be mistaken for) the write below.
  await new Promise((r) => setTimeout(r, 300));
  const changed = new Promise<string>((r) => { onChange = r; });
  await ws.write("a.ts", "export const a = 2;\n");
  expect(await changed).toBe("a.ts");
  unsub();
});

test("search finds matches with line/column, respects case sensitivity", async () => {
  const root = makeProject();
  writeFileSync(join(root, "needle.ts"), "const Needle = 1;\nfunction find() { return Needle; }\n");
  const ws = new Workspace(root);

  const caseSensitive = await ws.search("Needle", true);
  expect(caseSensitive.matches).toEqual([
    { path: "needle.ts", line: 1, column: 6, text: "const Needle = 1;" },
    { path: "needle.ts", line: 2, column: 25, text: "function find() { return Needle; }" },
  ]);
  expect(caseSensitive.truncated).toBe(false);

  const caseInsensitiveOnly = await ws.search("needle", false);
  expect(caseInsensitiveOnly.matches.length).toBe(2);

  const caseSensitiveMiss = await ws.search("needle", true);
  expect(caseSensitiveMiss.matches).toEqual([]);
});

test("search honors gitignore and skips .git", async () => {
  const root = makeProject(); // makeProject() already writes dist/junk.js with content "x" and ignores dist/
  const ws = new Workspace(root);
  const result = await ws.search("x", false);
  expect(result.matches.some((m) => m.path.startsWith("dist"))).toBe(false);
  expect(result.matches.some((m) => m.path.startsWith(".git"))).toBe(false);
});

test("search caps matches and reports truncated", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(root, `f${i}.ts`), Array(60).fill("target line").join("\n"));
  }
  const ws = new Workspace(root);
  const result = await ws.search("target", false);
  expect(result.matches.length).toBe(500);
  expect(result.truncated).toBe(true);
});

test("search skips binary files", async () => {
  const root = makeProject();
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0, 3, 0x66, 0x6f, 0x6f]));
  const ws = new Workspace(root);
  const result = await ws.search("foo", false);
  expect(result.matches.some((m) => m.path === "bin.dat")).toBe(false);
});

test("create makes a file, and a directory", async () => {
  const ws = new Workspace(makeProject());
  await ws.create("a.txt", "file");
  expect(await ws.read("a.txt")).toBe("");
  await ws.create("sub", "dir");
  expect((await ws.tree()).some((e) => e.path === "sub" && e.kind === "dir")).toBe(true);
});

test("create rejects a path outside the workspace root", async () => {
  const ws = new Workspace(makeProject());
  await expect(ws.create("../escape.txt", "file")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("create blocks a file through a not-yet-existing path behind a symlinked directory", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  const ws = new Workspace(root);
  await expect(ws.create("outdir/new.txt", "file")).rejects.toThrow(PathOutsideWorkspaceError);
  expect(existsSync(join(outside, "new.txt"))).toBe(false);
});

test("create blocks a directory through a not-yet-existing path behind a symlinked directory", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  const ws = new Workspace(root);
  await expect(ws.create("outdir/newdir", "dir")).rejects.toThrow(PathOutsideWorkspaceError);
  expect(existsSync(join(outside, "newdir"))).toBe(false);
});

test("create rejects a nested path through a symlinked directory without creating any intermediate directory outside the root", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  const ws = new Workspace(root);
  await expect(ws.create("outdir/sub/new.txt", "file")).rejects.toThrow(PathOutsideWorkspaceError);
  expect(existsSync(join(outside, "sub"))).toBe(false);

  await expect(ws.create("outdir/sub/newdir", "dir")).rejects.toThrow(PathOutsideWorkspaceError);
  expect(existsSync(join(outside, "sub"))).toBe(false);
});

test("rename moves a file to a new relative path", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await ws.rename("a.txt", "b.txt");
  expect(await ws.read("b.txt")).toBe("hi");
  await expect(ws.read("a.txt")).rejects.toThrow();
});

test("delete removes a file", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await ws.delete("a.txt");
  await expect(ws.read("a.txt")).rejects.toThrow();
});

test("delete removes a directory recursively", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("dir/a.txt", "hi");
  await ws.delete("dir");
  expect((await ws.tree()).some((e) => e.path.startsWith("dir"))).toBe(false);
});

test("move relocates a file into another directory", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await ws.create("dest", "dir");
  await ws.move("a.txt", "dest/a.txt");
  expect(await ws.read("dest/a.txt")).toBe("hi");
});

test("copy duplicates a file, leaving the original in place", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await ws.copy("a.txt", "b.txt");
  expect(await ws.read("a.txt")).toBe("hi");
  expect(await ws.read("b.txt")).toBe("hi");
});

test("copy onto an existing path rejects rather than overwriting", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await ws.write("b.txt", "existing");
  await expect(ws.copy("a.txt", "b.txt")).rejects.toThrow();
  expect(await ws.read("b.txt")).toBe("existing");
});

test("create rejects a file that already exists", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await expect(ws.create("a.txt", "file")).rejects.toThrow();
  expect(await ws.read("a.txt")).toBe("hi");
});

test("delete rejects a path outside the workspace root", async () => {
  const ws = new Workspace(makeProject());
  await expect(ws.delete("../escape.txt")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("rename rejects when destination is outside the workspace root", async () => {
  const ws = new Workspace(makeProject());
  await ws.write("a.txt", "hi");
  await expect(ws.rename("a.txt", "../escape.txt")).rejects.toThrow(PathOutsideWorkspaceError);
});

test("rename blocks a destination through a symlinked directory without moving the file outside the root", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  const ws = new Workspace(root);
  await ws.write("a.txt", "hi");
  await expect(ws.rename("a.txt", "outdir/escaped.txt")).rejects.toThrow(PathOutsideWorkspaceError);
  expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  expect(await ws.read("a.txt")).toBe("hi"); // source untouched
});

test("copy blocks a destination through a symlinked directory without copying the file outside the root", async () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "zero-outside-"));
  symlinkSync(outside, join(root, "outdir"));
  const ws = new Workspace(root);
  await ws.write("a.txt", "hi");
  await expect(ws.copy("a.txt", "outdir/escaped.txt")).rejects.toThrow(PathOutsideWorkspaceError);
  expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  expect(await ws.read("a.txt")).toBe("hi"); // source untouched
});

test("readSetting returns undefined when nothing has been written", async () => {
  const ws = new Workspace(makeProject());
  expect(await ws.readSetting("workbench")).toBeUndefined();
});

test("writeSetting then readSetting round-trips, creates settings.json under ~/.zero", async () => {
  const ws = new Workspace(makeProject());
  await ws.writeSetting("workbench", { theme: "dark", sidebarWidth: 240 });
  expect(await ws.readSetting("workbench")).toEqual({ theme: "dark", sidebarWidth: 240 });
  expect(existsSync(settingsPath())).toBe(true);
});

test("writeSetting preserves other keys", async () => {
  const ws = new Workspace(makeProject());
  await ws.writeSetting("workbench", { theme: "dark" });
  await ws.writeSetting("other", { foo: 1 });
  expect(await ws.readSetting("workbench")).toEqual({ theme: "dark" });
  expect(await ws.readSetting("other")).toEqual({ foo: 1 });
});

test("tree and search ignore .zero directory", async () => {
  const root = makeProject();
  const ws = new Workspace(root);
  await ws.writeSetting("workbench", { theme: "dark" });
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths.some((p) => p.startsWith(".zero"))).toBe(false);
  const result = await ws.search("dark", false);
  expect(result.matches.some((m) => m.path.startsWith(".zero"))).toBe(false);
});
