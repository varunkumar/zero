import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoScanner } from "./scanner";
import { Workspace } from "../../workspace";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("TodoScanner", () => {
  test("finds TODO/FIXME/HACK across files after a full scan", async () => {
    const root = makeRoot("zero-todos-");
    writeFileSync(join(root, "a.ts"), "// TODO: fix this\nconst x = 1;\n// FIXME broken\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.ts"), "// HACK: workaround\nconst y = 2;\n");
    writeFileSync(join(root, "c.ts"), "const z = 3;\n");

    const scanner = new TodoScanner({ workspace: new Workspace(root) });
    await scanner.runFullScan();

    const entries = scanner.list();
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "a.ts", line: 1, kind: "TODO", text: "fix this" },
        { path: "a.ts", line: 3, kind: "FIXME", text: "broken" },
        { path: "sub/b.ts", line: 1, kind: "HACK", text: "workaround" },
      ]),
    );
    expect(scanner.at("c.ts")).toEqual([]);
    expect(scanner.status()).toMatchObject({ ready: true, indexing: false });
  });

  test("respects .gitignore", async () => {
    const root = makeRoot("zero-todos-ignore-");
    writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(root, "ignored.ts"), "// TODO: should not show up\n");
    writeFileSync(join(root, "kept.ts"), "// TODO: should show up\n");

    const scanner = new TodoScanner({ workspace: new Workspace(root) });
    await scanner.runFullScan();

    expect(scanner.list().map((e) => e.path)).toEqual(["kept.ts"]);
  });

  test("onFileChanged incrementally re-scans a single file after debounce", async () => {
    const root = makeRoot("zero-todos-incr-");
    writeFileSync(join(root, "a.ts"), "const x = 1;\n");

    const scanner = new TodoScanner({ workspace: new Workspace(root) });
    await scanner.runFullScan();
    expect(scanner.at("a.ts")).toEqual([]);

    writeFileSync(join(root, "a.ts"), "// TODO: added later\n");
    scanner.onFileChanged("a.ts");
    await new Promise((r) => setTimeout(r, 250));

    expect(scanner.at("a.ts")).toEqual([{ path: "a.ts", line: 1, kind: "TODO", text: "added later" }]);
  });

  test("onFileChanged clears entries for a deleted file", async () => {
    const root = makeRoot("zero-todos-delete-");
    writeFileSync(join(root, "a.ts"), "// TODO: will be deleted\n");

    const scanner = new TodoScanner({ workspace: new Workspace(root) });
    await scanner.runFullScan();
    expect(scanner.at("a.ts")).toHaveLength(1);

    rmSync(join(root, "a.ts"));
    scanner.onFileChanged("a.ts");
    await new Promise((r) => setTimeout(r, 250));

    expect(scanner.at("a.ts")).toEqual([]);
  });
});
