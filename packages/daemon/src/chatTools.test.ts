import { expect, test } from "bun:test";
import { createChatTools } from "./chatTools";

function fakeDeps(overrides: Partial<Parameters<typeof createChatTools>[0]> = {}) {
  const files = new Map<string, string>([["a.ts", "export const a = 1;"]]);
  const checkpoints: string[] = [];
  return {
    sessionId: "s1",
    ws: {
      read: async (p: string) => { const c = files.get(p); if (c === undefined) throw new Error("not found"); return c; },
      write: async (p: string, c: string) => { files.set(p, c); },
      tree: async () => [{ path: "a.ts", kind: "file" as const }],
      search: async () => ({ matches: [], truncated: false }),
    },
    lsp: {
      hover: async () => "type info",
      definition: async () => [{ path: "a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    },
    graphQuery: () => ({ text: "graph result" }),
    execCommand: async () => ({ exitCode: 0, output: "ran" }),
    checkpoint: { checkpoint: async (_id: string, msg: string) => { checkpoints.push(msg); } },
    _files: files,
    _checkpoints: checkpoints,
    ...overrides,
  };
}

test("fs_read reads an existing file", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const fsRead = tools.find((t) => t.name === "fs_read")!;
  expect(await fsRead.execute({ path: "a.ts" })).toBe("export const a = 1;");
});

test("fs_write requires approval, previews a diff, writes on execute, and checkpoints", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const fsWrite = tools.find((t) => t.name === "fs_write")!;
  expect(fsWrite.needsApproval).toBe(true);

  const preview = await fsWrite.preview!({ path: "a.ts", content: "export const a = 2;" });
  expect(preview).toContain("-export const a = 1;");
  expect(preview).toContain("+export const a = 2;");
  expect(deps._files.get("a.ts")).toBe("export const a = 1;"); // preview does not write

  const result = await fsWrite.execute({ path: "a.ts", content: "export const a = 2;" });
  expect(result).toContain("a.ts");
  expect(deps._files.get("a.ts")).toBe("export const a = 2;");
  expect(deps._checkpoints).toEqual(["agent: fs_write a.ts"]);
});

test("fs_edit replaces a unique match and errors on an ambiguous one", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const fsEdit = tools.find((t) => t.name === "fs_edit")!;
  expect(fsEdit.needsApproval).toBe(true);

  const result = await fsEdit.execute({ path: "a.ts", oldText: "= 1", newText: "= 42" });
  expect(deps._files.get("a.ts")).toBe("export const a = 42;");
  expect(result).toContain("a.ts");

  deps._files.set("b.ts", "x x");
  const ambiguous = await fsEdit.execute({ path: "b.ts", oldText: "x", newText: "y" }).catch((e: unknown) => e);
  expect(String(ambiguous)).toContain("2 locations");

  // Verify preview() also throws on ambiguous match, not returning an error string
  const previewError = await fsEdit.preview!({ path: "b.ts", oldText: "x", newText: "y" }).catch((e: unknown) => e);
  expect(String(previewError)).toContain("2 locations");
});

test("run_command requires approval and checkpoints when it changes files", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const runCmd = tools.find((t) => t.name === "run_command")!;
  expect(runCmd.needsApproval).toBe(true);
  expect(await runCmd.preview!({ command: "echo hi" })).toBe("echo hi");

  const result = await runCmd.execute({ command: "echo hi" });
  expect(result).toContain("ran");
  expect(deps._checkpoints).toEqual(["agent: run_command echo hi"]);
});

test("graph_query wraps Graphify's query()", async () => {
  const deps = fakeDeps();
  const tools = createChatTools(deps);
  const graphQuery = tools.find((t) => t.name === "graph_query")!;
  expect(graphQuery.needsApproval).toBeUndefined();
  expect(await graphQuery.execute({ q: "foo" })).toBe("graph result");
});
