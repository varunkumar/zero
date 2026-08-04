import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, PathOutsideWorkspaceError } from "./workspace";

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
