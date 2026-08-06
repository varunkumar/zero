import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "./client";
import type { LspDiagnostic } from "@zero/protocol";

// Mirrors client.test.ts's TypeScript coverage (checklist item "Verify
// Python, if a Python project is available" from the M2 plan's manual
// smoke test) - pyright is a real devDependency (packages/daemon/package.json)
// and a real python3 interpreter is expected on PATH, so this spawns a real
// pyright-langserver rather than mocking the protocol.
test("pyright: sync produces diagnostics, hover and definition resolve", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lsp-py-"));
  const filePath = join(root, "a.py");
  const badContent = "def greet(name: str) -> str:\n    return name\n\n\ngreeting: str = 42\nprint(greeting)\n";
  writeFileSync(filePath, badContent);

  const diagnosticsByPath = new Map<string, LspDiagnostic[]>();
  const client = new LspClient("pyright-langserver", ["--stdio"], root,
    (path, diagnostics) => diagnosticsByPath.set(path, diagnostics));

  await client.sync(filePath, badContent, "python");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if ((diagnosticsByPath.get(filePath)?.length ?? 0) > 0) { clearInterval(check); resolve(); }
    }, 100);
  });
  expect(diagnosticsByPath.get(filePath)!.length).toBeGreaterThan(0);

  const validContent = "def greet(name: str) -> str:\n    return name\n\n\ngreeting: str = \"hi\"\nprint(greeting)\n";
  writeFileSync(filePath, validContent);
  await client.sync(filePath, validContent, "python");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (diagnosticsByPath.get(filePath)?.length === 0) { clearInterval(check); resolve(); }
    }, 100);
  });
  expect(diagnosticsByPath.get(filePath)).toEqual([]);

  // "greeting" on the print() line (line 5, 0-based) - hover over its usage.
  const hover = await client.hover(filePath, { line: 5, character: 8 });
  expect(hover).toBeTruthy();
  expect(hover!.toLowerCase()).toContain("greeting");

  // Go to definition from that same usage should resolve back to line 4
  // (0-based), where `greeting` is declared.
  const definitions = await client.definition(filePath, { line: 5, character: 8 });
  expect(definitions.length).toBeGreaterThan(0);
  expect(definitions[0]!.path).toBe(filePath);
  expect(definitions[0]!.range.start.line).toBe(4);

  client.close(filePath);
  client.dispose();
}, 30000);
