import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspService } from "./service";
import { DEFAULT_LSP_SERVERS } from "./registry";
import { Workspace } from "../workspace";
import type { LspDiagnostic } from "@zero/protocol";

test("routes by extension, syncs, and answers hover/definition/contextAt", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  writeFileSync(join(root, "a.ts"), "const greeting: string = \"hi\";\nconsole.log(greeting);\n");

  const diagnostics = new Map<string, LspDiagnostic[]>();
  const service = new LspService(new Workspace(root), DEFAULT_LSP_SERVERS, (path, d) => diagnostics.set(path, d));

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
  const service = new LspService(new Workspace(root), DEFAULT_LSP_SERVERS, () => {});
  await expect(service.sync("README.md", "# hi")).resolves.toBeUndefined();
  expect(await service.hover("README.md", { line: 0, character: 0 })).toBeNull();
  expect(await service.contextAt("README.md", { line: 0, character: 0 })).toEqual([]);
  service.dispose();
});

test("isFailed reports a server that never speaks the LSP protocol, and false before any sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  writeFileSync(join(root, "a.ts"), "const a = 1;\n");
  // Spawns fine but never responds to `initialize` — same fixture used by
  // client.test.ts's own initialize-timeout test, chosen here specifically
  // to avoid a bogus-binary spawn error racing a still-open stream write
  // (an unrelated pre-existing edge case, not what this test is about).
  const servers = { typescript: { command: "sh", args: ["-c", "cat > /dev/null"], languageIds: ["typescript"] } };
  const service = new LspService(new Workspace(root), servers, () => {});

  // No client spawned yet for this path — not a failure, just unsynced.
  expect(await service.isFailed("a.ts")).toBe(false);

  await service.sync("a.ts", "const a = 1;\n");
  expect(await service.isFailed("a.ts")).toBe(true); // sync() itself awaits readiness (incl. the 5s timeout)
  // A path with no configured server at all is never "failed".
  expect(await service.isFailed("README.md")).toBe(false);

  service.dispose();
}, 15000);

test("a failed server degrades hover/definition/contextAt to empty, never throws (editor stays usable)", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  writeFileSync(join(root, "a.ts"), "const a = 1;\n");
  const servers = { typescript: { command: "sh", args: ["-c", "cat > /dev/null"], languageIds: ["typescript"] } };
  const service = new LspService(new Workspace(root), servers, () => {});

  await service.sync("a.ts", "const a = 1;\n");
  await expect(service.hover("a.ts", { line: 0, character: 0 })).resolves.toBeNull();
  await expect(service.definition("a.ts", { line: 0, character: 0 })).resolves.toEqual([]);
  await expect(service.contextAt("a.ts", { line: 0, character: 0 })).resolves.toEqual([]);

  service.dispose();
}, 15000);

test("a path that escapes the workspace root is a silent no-op, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lspsvc-"));
  const service = new LspService(new Workspace(root), DEFAULT_LSP_SERVERS, () => {});
  await expect(service.sync("../../../../etc/hosts.ts", "x")).resolves.toBeUndefined();
  expect(await service.hover("../../../../etc/hosts.ts", { line: 0, character: 0 })).toBeNull();
  expect(await service.definition("../../../../etc/hosts.ts", { line: 0, character: 0 })).toEqual([]);
  expect(await service.contextAt("../../../../etc/hosts.ts", { line: 0, character: 0 })).toEqual([]);
  service.dispose();
});
