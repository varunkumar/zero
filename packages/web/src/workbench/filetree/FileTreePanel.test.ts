import { describe, expect, test } from "bun:test";
import type { RpcClient } from "@zero/protocol";
import {
  confirmAndDelete,
  containingDir,
  createEntry,
  deleteEntry,
  insertDraft,
  joinPath,
  pasteEntry,
  renameEntry,
} from "./FileTreePanel";

/** Records every `client.request` call so tests can assert exactly which
 * `fs/*` RPC an action issues, without a DOM (this package has no DOM test
 * shim - see FileOpener.test.ts's rankPaths for the same
 * extract-the-logic-and-test-it-directly precedent). */
function fakeClient(): { client: RpcClient; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return {};
    },
  } as unknown as RpcClient;
  return { client, calls };
}

describe("containingDir", () => {
  test("a directory node contains itself", () => {
    expect(containingDir("src/utils", "dir")).toBe("src/utils");
  });

  test("a file node's containing dir is its parent", () => {
    expect(containingDir("src/utils/helpers.ts", "file")).toBe("src/utils");
  });

  test("a root-level file's containing dir is the workspace root", () => {
    expect(containingDir("README.md", "file")).toBe("");
  });

  test("no selection falls back to the workspace root", () => {
    expect(containingDir(null, undefined)).toBe("");
  });
});

describe("joinPath", () => {
  test("joins a non-root dir and a name with a slash", () => {
    expect(joinPath("src", "index.ts")).toBe("src/index.ts");
  });

  test("the workspace root joins with no leading slash", () => {
    expect(joinPath("", "index.ts")).toBe("index.ts");
  });
});

describe("createEntry", () => {
  test("New File in a selected directory calls fs/create with the joined path and kind", async () => {
    const { client, calls } = fakeClient();
    await createEntry(client, "src", "file", "index.ts");
    expect(calls).toEqual([{ method: "fs/create", params: { path: "src/index.ts", kind: "file" } }]);
  });

  test("New Folder at the workspace root calls fs/create with a root-relative path", async () => {
    const { client, calls } = fakeClient();
    await createEntry(client, "", "dir", "widgets");
    expect(calls).toEqual([{ method: "fs/create", params: { path: "widgets", kind: "dir" } }]);
  });
});

describe("renameEntry", () => {
  test("renames within the same directory", async () => {
    const { client, calls } = fakeClient();
    await renameEntry(client, "src/old.ts", "new.ts");
    expect(calls).toEqual([{ method: "fs/rename", params: { path: "src/old.ts", newPath: "src/new.ts" } }]);
  });

  test("renaming a root-level entry keeps it at the root", async () => {
    const { client, calls } = fakeClient();
    await renameEntry(client, "old.ts", "new.ts");
    expect(calls).toEqual([{ method: "fs/rename", params: { path: "old.ts", newPath: "new.ts" } }]);
  });
});

describe("deleteEntry", () => {
  test("calls fs/delete with the path", async () => {
    const { client, calls } = fakeClient();
    await deleteEntry(client, "src/dead.ts");
    expect(calls).toEqual([{ method: "fs/delete", params: { path: "src/dead.ts" } }]);
  });
});

describe("confirmAndDelete", () => {
  test("does not call fs/delete when the confirm dialog is declined", async () => {
    const { client, calls } = fakeClient();
    const ran = await confirmAndDelete(client, "src/dead.ts", () => false);
    expect(ran).toBe(false);
    expect(calls).toEqual([]);
  });

  test("calls fs/delete only after the confirm dialog is accepted", async () => {
    const { client, calls } = fakeClient();
    const ran = await confirmAndDelete(client, "src/dead.ts", () => true);
    expect(ran).toBe(true);
    expect(calls).toEqual([{ method: "fs/delete", params: { path: "src/dead.ts" } }]);
  });

  test("passes a message naming the path and warning it's permanent", async () => {
    const { client } = fakeClient();
    let seenMessage = "";
    await confirmAndDelete(client, "src/dead.ts", (message) => {
      seenMessage = message;
      return false;
    });
    expect(seenMessage).toContain("src/dead.ts");
  });
});

describe("insertDraft", () => {
  test("inserts at the front of the root list when parentId is null", () => {
    const roots = [{ id: "b.ts", name: "b.ts", kind: "file" as const }];
    const draft = { id: "__draft__", name: "", kind: "file" as const };
    expect(insertDraft(roots, null, draft)).toEqual([draft, { id: "b.ts", name: "b.ts", kind: "file" as const }]);
  });

  test("inserts as the first child of the matching directory", () => {
    const roots = [
      { id: "src", name: "src", kind: "dir" as const, children: [{ id: "src/a.ts", name: "a.ts", kind: "file" as const }] },
    ];
    const draft = { id: "__draft__", name: "", kind: "file" as const };
    const result = insertDraft(roots, "src", draft);
    expect(result[0]!.children).toEqual([draft, { id: "src/a.ts", name: "a.ts", kind: "file" as const }]);
  });

  test("finds the target directory nested inside another directory", () => {
    const roots = [
      {
        id: "src",
        name: "src",
        kind: "dir" as const,
        children: [{ id: "src/utils", name: "utils", kind: "dir" as const, children: [] }],
      },
    ];
    const draft = { id: "__draft__", name: "", kind: "dir" as const };
    const result = insertDraft(roots, "src/utils", draft);
    expect(result[0]!.children![0]!.children).toEqual([draft]);
  });

  test("leaves the tree unchanged when the target directory isn't found", () => {
    const roots = [{ id: "a.ts", name: "a.ts", kind: "file" as const }];
    const draft = { id: "__draft__", name: "", kind: "file" as const };
    expect(insertDraft(roots, "missing", draft)).toEqual(roots);
  });
});

describe("pasteEntry", () => {
  test("cut+paste calls fs/move with the target directory's joined path", async () => {
    const { client, calls } = fakeClient();
    await pasteEntry(client, { path: "src/a.ts", mode: "cut" }, "lib");
    expect(calls).toEqual([{ method: "fs/move", params: { path: "src/a.ts", newPath: "lib/a.ts" } }]);
  });

  test("copy+paste calls fs/copy instead of fs/move", async () => {
    const { client, calls } = fakeClient();
    await pasteEntry(client, { path: "src/a.ts", mode: "copy" }, "lib");
    expect(calls).toEqual([{ method: "fs/copy", params: { path: "src/a.ts", newPath: "lib/a.ts" } }]);
  });

  test("pasting at the workspace root produces a root-relative path", async () => {
    const { client, calls } = fakeClient();
    await pasteEntry(client, { path: "src/a.ts", mode: "cut" }, "");
    expect(calls).toEqual([{ method: "fs/move", params: { path: "src/a.ts", newPath: "a.ts" } }]);
  });
});
