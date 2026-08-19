import { expect, test } from "bun:test";

test("todos plugin UI bundles without error and exports mount", async () => {
  const entryPoint = new URL("./src/index.tsx", import.meta.url).pathname;
  // Same flags scripts/build-plugin-ui.ts ships with, so the smoke test
  // exercises the configuration that actually gets served.
  const proc = Bun.spawn(
    ["bun", "build", entryPoint, "--target=browser", "--format=esm", "--minify"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "production" } },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) console.error(stderr);
  expect(exitCode).toBe(0);
  // Minification renames the declaration (`function vp(...)`), so the
  // export clause is what proves `mount` is still the public entry point.
  expect(stdout).toMatch(/export\s*\{[^}]*\bas mount\b/);
});
