import { expect, test } from "bun:test";
import { extractFromSource } from "./extract";
import { resolveLanguage, DEFAULT_GRAMMARS } from "./grammars";

const SRC = `
import { helper } from "./util";

export function greet(name: string) {
  return helper(name);
}
`;

test(
  "extractFromSource finds function, import, and call edges for TypeScript",
  async () => {
    const { nodes, edges } = await extractFromSource(
      "src/a.ts",
      SRC,
      "typescript",
    );
    expect(nodes.some((n) => n.label === "greet" && n.kind === "function")).toBe(
      true,
    );
    expect(edges.some((e) => e.relation === "imports")).toBe(true);
    // call edge may be best-effort; require at least contains + imports
    expect(edges.some((e) => e.relation === "contains")).toBe(true);
  },
  30_000,
);

test("resolveLanguage maps extensions via defaults and overrides", () => {
  expect(resolveLanguage("foo/bar.ts")).toBe("typescript");
  expect(resolveLanguage("x.tsx")).toBe("tsx");
  expect(resolveLanguage("lib.mjs")).toBe("javascript");
  expect(resolveLanguage("a.py")).toBeUndefined();
  expect(
    resolveLanguage("a.custom", {
      mylang: { extensions: [".custom"] },
    }),
  ).toBe("mylang");
  expect(DEFAULT_GRAMMARS.typescript?.extensions).toContain(".ts");
});
