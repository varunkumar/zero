import { expect, test } from "bun:test";

test("todos plugin UI bundles without error and exports mount", async () => {
  const entryPoint = new URL("./src/index.tsx", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [entryPoint],
    target: "browser",
    format: "esm",
  });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  expect(output).toContain("function mount");
});
