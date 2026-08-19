import { expect, test } from "bun:test";

test("todos plugin UI bundles without error and exports mount", async () => {
  const entryPoint = new URL("./src/index.tsx", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "build", entryPoint, "--target=browser", "--format=esm"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) console.error(stderr);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("function mount");
});
