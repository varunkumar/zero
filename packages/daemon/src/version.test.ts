import { expect, test } from "bun:test";

// VERSION is computed once at module-load time, so the override has to be
// proven in a fresh subprocess rather than by re-importing in-process.
test("ZERO_VERSION overrides the import.meta.url-relative package.json lookup", async () => {
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `import { VERSION } from "${import.meta.dir}/version.ts"; console.log(VERSION);`,
    ],
    env: { ...process.env, ZERO_VERSION: "9.9.9-test" },
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  expect(output.trim()).toBe("9.9.9-test");
});

test("without ZERO_VERSION, VERSION comes from the root package.json", async () => {
  const env = { ...process.env };
  delete env.ZERO_VERSION;
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `import { VERSION } from "${import.meta.dir}/version.ts"; console.log(VERSION);`,
    ],
    env,
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
});
