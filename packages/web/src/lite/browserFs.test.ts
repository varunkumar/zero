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

test("create propagates non-NotFound probe errors", async () => {
  const ws = await seeded();
  await expect(ws.create("src", "file")).rejects.toMatchObject({ name: "TypeMismatchError" });
});

test("copy does not overwrite an existing destination", async () => {
  const ws = await seeded();
  await ws.write("src/b.ts", "other");
  await expect(ws.copy("src/a.ts", "src/b.ts")).rejects.toThrow("already exists");
  expect(await ws.read("src/b.ts")).toBe("other");
});

test("rename and move of a path onto itself do not delete", async () => {
  const ws = await seeded();
  await ws.rename("src/a.ts", "src/a.ts");
  expect(await ws.read("src/a.ts")).toBe("hello");
  await ws.move("src/a.ts", "src/a.ts");
  expect(await ws.read("src/a.ts")).toBe("hello");
});

test("search finds a literal with 1-based line and column", async () => {
  const ws = await seeded();
  await ws.write("src/a.ts", "alpha\nhello world\n");
  const res = await ws.search("hello");
  expect(res.truncated).toBe(false);
  expect(res.matches).toEqual([{ path: "src/a.ts", line: 2, column: 1, text: "hello world" }]);
});

test("search is case-insensitive by default and honors caseSensitive", async () => {
  const ws = await seeded();
  await ws.write("src/a.ts", "Hello");
  expect((await ws.search("hello")).matches).toHaveLength(1);
  expect((await ws.search("hello", true)).matches).toHaveLength(0);
});

test("search and tree honor .gitignore and still skip node_modules", async () => {
  const ws = await seeded();
  await ws.write(".gitignore", "secret.txt\n");
  await ws.write("secret.txt", "nope");
  await ws.write("src/ok.ts", "hello");
  const paths = (await ws.tree()).map((e) => e.path);
  expect(paths).not.toContain("secret.txt");
  expect(paths).toContain("src/ok.ts");
  const res = await ws.search("nope");
  expect(res.matches).toEqual([]);
  expect((await ws.read("secret.txt"))).toBe("nope");
});

test("search sets truncated when the match cap is hit", async () => {
  const ws = await seeded();
  const lines = Array.from({ length: 250 }, (_, i) => `hit ${i}`).join("\n");
  await ws.write("src/a.ts", lines);
  const res = await ws.search("hit");
  expect(res.matches.length).toBe(200);
  expect(res.truncated).toBe(true);
});

test("readBinary round-trips bytes as base64 with the right mime type", async () => {
  const ws = await seeded();
  // MemFile only stores text (see memDir.ts), so round-trip via a string
  // that maps 1:1 through btoa/atob — this test only needs to prove
  // readBinary reaches the file and returns {base64, mimeType}, not that
  // MemFile itself can hold arbitrary binary content (it can't; content here
  // is ASCII-safe for that reason, not because readBinary requires it).
  await ws.write("src/pic.png", "fake-bytes");
  const result = await ws.readBinary("src/pic.png");
  expect(result.mimeType).toBe("image/png");
  expect(atob(result.base64)).toBe("fake-bytes");
});
