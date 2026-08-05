import { expect, test } from "bun:test";
import { DEFAULT_LSP_SERVERS, languageForPath } from "./registry";

test("default registry covers typescript and python by extension", () => {
  expect(languageForPath("a.ts")).toBe("typescript");
  expect(languageForPath("a.tsx")).toBe("typescriptreact");
  expect(languageForPath("a.js")).toBe("javascript");
  expect(languageForPath("a.jsx")).toBe("javascriptreact");
  expect(languageForPath("a.py")).toBe("python");
  expect(languageForPath("a.md")).toBeUndefined();

  expect(DEFAULT_LSP_SERVERS.typescript!.languageIds).toContain("typescript");
  expect(DEFAULT_LSP_SERVERS.python!.languageIds).toContain("python");
});
