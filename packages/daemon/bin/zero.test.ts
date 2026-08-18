import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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

test("ZERO_WEB_DIST overrides the import.meta.url-relative webDist lookup", async () => {
  // Reproduces the failure a `bun build --compile` sidecar hits: its
  // import.meta.url points into a virtual embedded path, not a real
  // location on disk, so the default `new URL("../../web/dist",
  // import.meta.url)` computation resolves to a directory that doesn't
  // exist. ZERO_WEB_DIST lets a compiled sidecar (Zero IDE's Tauri shell)
  // point at its own bundled web/dist copy instead.
  const root = mkdtempSync(join(tmpdir(), "zero-webdist-test-root-"));
  const webDist = mkdtempSync(join(tmpdir(), "zero-webdist-test-dist-"));
  writeFileSync(join(webDist, "index.html"), "<html>zero-web-dist-override-marker</html>");
  mkdirSync(join(webDist, "assets"));
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "run", join(import.meta.dir, "zero.ts"), "serve", root, "--port", "0", "--json"],
      env: { ...process.env, ZERO_WEB_DIST: webDist },
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
    const { port } = JSON.parse(line!);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    proc.kill();

    expect(body).toContain("zero-web-dist-override-marker");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(webDist, { recursive: true, force: true });
  }
});
