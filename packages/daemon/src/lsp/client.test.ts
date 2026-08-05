import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient } from "./client";
import type { LspDiagnostic } from "@zero/protocol";

test("sync produces diagnostics, hover and definition resolve", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lsp-"));
  const filePath = join(root, "a.ts");
  writeFileSync(filePath, "const greeting: string = 42;\n");

  const diagnosticsByPath = new Map<string, LspDiagnostic[]>();
  const client = new LspClient("typescript-language-server", ["--stdio"], root,
    (path, diagnostics) => diagnosticsByPath.set(path, diagnostics));

  await client.sync(filePath, "const greeting: string = 42;\n", "typescript");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (diagnosticsByPath.has(filePath)) { clearInterval(check); resolve(); }
    }, 50);
  });
  expect(diagnosticsByPath.get(filePath)!.length).toBeGreaterThan(0);
  expect(diagnosticsByPath.get(filePath)![0]!.message).toContain("not assignable");

  const validContent = "const greeting: string = \"hi\";\nconsole.log(greeting);\n";
  writeFileSync(filePath, validContent);
  await client.sync(filePath, validContent, "typescript");

  const hover = await client.hover(filePath, { line: 0, character: 6 });
  expect(hover).toBeTruthy();
  expect(hover!.toLowerCase()).toContain("greeting");

  const definitions = await client.definition(filePath, { line: 1, character: 12 });
  expect(definitions.length).toBeGreaterThan(0);
  expect(definitions[0]!.path).toBe(filePath);

  client.close(filePath);
  client.dispose();
}, 20000);
