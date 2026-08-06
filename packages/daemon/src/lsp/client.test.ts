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

test("a process that spawns, reads stdin, but never writes a response forces the 5s initialize timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-lsp-"));
  const filePath = join(root, "a.ts");
  writeFileSync(filePath, "const greeting: string = \"hi\";\n");

  // `sh -c 'cat > /dev/null'` spawns successfully (so the "error" listener
  // never fires) and happily consumes the `initialize` request written to
  // its stdin, but writes nothing at all back to stdout: there is no echo,
  // so vscode-jsonrpc has nothing to parse and #conn.sendRequest never
  // settles on its own. The only thing that can resolve #ready is the 5000ms
  // Promise.race timeout in the constructor. If that timeout (or the
  // Promise.race wrapping it) were removed, this hover() call would hang
  // forever and the test would fail on Bun's own 10s test timeout instead of
  // observing the ~5s window asserted below.
  const client = new LspClient("sh", ["-c", "cat > /dev/null"], root, () => {});

  const start = Date.now();
  const hover = await client.hover(filePath, { line: 0, character: 6 });
  const elapsedMs = Date.now() - start;

  expect(hover).toBeNull();
  // Must have actually waited for the ~5s timer, not resolved near-instantly
  // like the old `cat`-echo bug (which rejected in ~4ms via a spurious
  // "Unhandled method initialize" error).
  expect(elapsedMs).toBeGreaterThan(4000);
  expect(elapsedMs).toBeLessThan(9000);

  client.dispose();
}, 15000);
