import { describe, expect, test } from "bun:test";
import { terminalTheme } from "./theme";

describe("terminal theme reactivity", () => {
  test("terminalTheme produces different background colors for light vs dark", () => {
    const light = terminalTheme("light");
    const dark = terminalTheme("dark");
    expect(light.background).not.toBe(dark.background);
  });
});
