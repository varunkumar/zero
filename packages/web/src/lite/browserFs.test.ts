import { expect, test } from "bun:test";
import { assertSafePath } from "./paths";
import { createMemRoot } from "./memDir";
import { BrowserFSWorkspace } from "./browserFs";

test("assertSafePath accepts relative POSIX paths", () => {
  expect(assertSafePath("src/app.ts")).toEqual(["src", "app.ts"]);
  expect(assertSafePath("")).toEqual([]);
  expect(assertSafePath(".")).toEqual([]);
});

test("assertSafePath rejects traversal and absolute paths", () => {
  expect(() => assertSafePath("../secret")).toThrow();
  expect(() => assertSafePath("/etc/passwd")).toThrow();
  expect(() => assertSafePath("C:\\Windows")).toThrow();
  expect(() => assertSafePath("foo/../bar")).toThrow();
});

async function seeded() {
  const root = createMemRoot("proj");
  const src = await root.getDirectoryHandle("src", { create: true });
  const f = await src.getFileHandle("a.ts", { create: true });
  const w = await f.createWritable();
  await w.write("hello");
  await w.close();
  return new BrowserFSWorkspace(root);
}

test("read/write/tree round-trip", async () => {
  const ws = await seeded();
  expect(await ws.read("src/a.ts")).toBe("hello");
  await ws.write("src/a.ts", "world");
  expect(await ws.read("src/a.ts")).toBe("world");
  const paths = (await ws.tree()).map((e) => e.path).sort();
  expect(paths).toContain("src");
  expect(paths).toContain("src/a.ts");
});

test("create file and dir; create of existing path fails", async () => {
  const ws = await seeded();
  await ws.create("src/b.ts", "file");
  expect(await ws.read("src/b.ts")).toBe("");
  await ws.create("lib", "dir");
  await expect(ws.create("src/a.ts", "file")).rejects.toThrow();
});

test("rename, move, copy, delete", async () => {
  const ws = await seeded();
  await ws.rename("src/a.ts", "src/c.ts");
  expect(await ws.read("src/c.ts")).toBe("hello");
  await ws.move("src/c.ts", "c.ts");
  expect(await ws.read("c.ts")).toBe("hello");
  await ws.copy("c.ts", "src/copy.ts");
  expect(await ws.read("src/copy.ts")).toBe("hello");
  await ws.delete("c.ts");
  await expect(ws.read("c.ts")).rejects.toThrow();
});

test("tree omits .git and node_modules at any depth", async () => {
  const ws = await seeded();
  await ws.write(".git/HEAD", "ref");
  await ws.write("node_modules/x/index.js", "1");
  await ws.write("src/node_modules/y/index.js", "2");
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths.some((p) => p.split("/").includes(".git"))).toBe(false);
  expect(paths.some((p) => p.split("/").includes("node_modules"))).toBe(false);
});

test("rejects .. in read", async () => {
  const ws = await seeded();
  await expect(ws.read("../outside")).rejects.toThrow();
});
