import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("serve --json prints exactly one JSON line with port and token", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-json-test-"));
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "run", join(import.meta.dir, "zero.ts"), "serve", root, "--port", "0", "--json"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let line: string | undefined;
    while (!line) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      const nl = buf.indexOf("\n");
      if (nl >= 0) line = buf.slice(0, nl);
    }
    proc.kill();

    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(typeof parsed.port).toBe("number");
    expect(typeof parsed.token).toBe("string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
