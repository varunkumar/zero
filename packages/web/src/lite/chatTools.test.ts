import { expect, test } from "bun:test";
import { createMemRoot } from "./memDir";
import { BrowserFSWorkspace } from "./browserFs";
import { createLiteChatTools } from "./chatTools";

test("fs_write requires approval and does not write until execute", async () => {
  const root = createMemRoot("proj");
  const src = await root.getDirectoryHandle("src", { create: true });
  const f = await src.getFileHandle("a.ts", { create: true });
  const w = await f.createWritable();
  await w.write("hello");
  await w.close();
  const ws = new BrowserFSWorkspace(root);
  const tools = createLiteChatTools(ws);
  const write = tools.find((t) => t.name === "fs_write")!;
  expect(write.needsApproval).toBe(true);
  expect(tools.some((t) => t.name === "run_command")).toBe(false);
  const preview = await write.preview!({ path: "src/a.ts", content: "x" });
  expect(preview).toContain("-hello");
  expect(preview).toContain("+x");
  expect(await ws.read("src/a.ts")).toBe("hello");
  await write.execute({ path: "src/a.ts", content: "x" });
  expect(await ws.read("src/a.ts")).toBe("x");
});

test("fs_edit requires a unique oldText", async () => {
  const root = createMemRoot("proj");
  await (await root.getDirectoryHandle("src", { create: true }))
    .getFileHandle("a.ts", { create: true }).then(async (f) => {
      const w = await f.createWritable();
      await w.write("aa aa");
      await w.close();
    });
  const ws = new BrowserFSWorkspace(root);
  const edit = createLiteChatTools(ws).find((t) => t.name === "fs_edit")!;
  await expect(edit.preview!({ path: "src/a.ts", oldText: "aa", newText: "b" })).rejects.toThrow(/unique/);
});

test("fs_edit replaces a unique occurrence on execute", async () => {
  const root = createMemRoot("proj");
  const f = await root.getFileHandle("a.ts", { create: true });
  const w = await f.createWritable();
  await w.write("one two three");
  await w.close();
  const ws = new BrowserFSWorkspace(root);
  const edit = createLiteChatTools(ws).find((t) => t.name === "fs_edit")!;
  await edit.execute({ path: "a.ts", oldText: "two", newText: "TWO" });
  expect(await ws.read("a.ts")).toBe("one TWO three");
});

test("fs_read, fs_tree, fs_search do not require approval", async () => {
  const root = createMemRoot("proj");
  const ws = new BrowserFSWorkspace(root);
  const tools = createLiteChatTools(ws);
  for (const name of ["fs_read", "fs_tree", "fs_search"]) {
    expect(tools.find((t) => t.name === name)?.needsApproval).toBeUndefined();
  }
});
