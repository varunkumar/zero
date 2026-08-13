import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLaunchBanner, nanoHostStatusLine, runClaudeCli } from "./claude";
import { useTempZeroHome } from "../testSupport/zeroHome";

useTempZeroHome();

test("claudeLaunchBanner includes the web URL and the ANTHROPIC env line", () => {
  const banner = claudeLaunchBanner({ webUrl: "http://127.0.0.1:4820/?token=abc", gatewayUrl: "http://127.0.0.1:5000", apiKey: "key123" });
  expect(banner).toContain("http://127.0.0.1:4820/?token=abc");
  expect(banner).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:5000 ANTHROPIC_API_KEY=key123 claude");
});

test("nanoHostStatusLine reports only on transitions", () => {
  expect(nanoHostStatusLine(false, false)).toBeNull();
  expect(nanoHostStatusLine(false, true)).toBe("Nano host attached ✓");
  expect(nanoHostStatusLine(true, true)).toBeNull();
  expect(nanoHostStatusLine(true, false)).toBe("waiting for a Zero tab with Gemini Nano...");
});

test("runClaudeCli starts the daemon+gateway, prints the banner, and polls until aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const lines: string[] = [];
  const controller = new AbortController();
  let ticks = 0;

  const exitCode = await runClaudeCli(root, undefined, {
    // Ephemeral port: 4820 (the production default) would collide with a
    // real `zero serve`/`zero claude` running on the same machine.
    port: 0,
    log: (l) => lines.push(l),
    signal: controller.signal,
    sleep: async () => { ticks++; if (ticks >= 3) controller.abort(); },
  });

  expect(exitCode).toBe(0);
  expect(lines.some((l) => l.includes("zero ready:"))).toBe(true);
  expect(lines.some((l) => l.includes("ANTHROPIC_BASE_URL="))).toBe(true);
  expect(lines.some((l) => l.includes("waiting for a Zero tab with Gemini Nano..."))).toBe(true);
  expect(ticks).toBeGreaterThanOrEqual(3);
});
