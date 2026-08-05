import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspService } from "./service";
import { DEFAULT_LSP_SERVERS } from "./registry";
import type { LspDiagnostic } from "@zero/protocol";

test("routes by extension, syncs, and answers hover/definition/contextAt", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  writeFileSync(join(root, "a.ts"), "const greeting: string = \"hi\";\nconsole.log(greeting);\n");

  const diagnostics = new Map<string, LspDiagnostic[]>();
  const service = new LspService(root, DEFAULT_LSP_SERVERS, (path, d) => diagnostics.set(path, d));

  await service.sync("a.ts", "const greeting: string = \"hi\";\nconsole.log(greeting);\n");
  const hover = await service.hover("a.ts", { line: 0, character: 6 });
  expect(hover).toBeTruthy();

  const chunks = await service.contextAt("a.ts", { line: 0, character: 6 });
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]!.text).toBe(hover as string);

  const definitions = await service.definition("a.ts", { line: 1, character: 12 });
  expect(definitions.length).toBeGreaterThan(0);
  expect(definitions[0]!.path).toBe("a.ts"); // returned relative to root

  service.dispose();
}, 20000);

test("an unconfigured extension is a silent no-op, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  const service = new LspService(root, DEFAULT_LSP_SERVERS, () => {});
  await expect(service.sync("README.md", "# hi")).resolves.toBeUndefined();
  expect(await service.hover("README.md", { line: 0, character: 0 })).toBeNull();
  expect(await service.contextAt("README.md", { line: 0, character: 0 })).toEqual([]);
  service.dispose();
});
