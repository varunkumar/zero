import { describe, expect, test } from "bun:test";
import { terminalTheme } from "./theme";

describe("terminalTheme", () => {
  test.each(["light", "dark"] as const)("%s theme sets an explicit cursor color", (theme) => {
    const t = terminalTheme(theme);
    expect(t.cursor).toBeTruthy();
    expect(t.cursorAccent).toBeTruthy();
  });

  test.each(["light", "dark"] as const)("%s theme's cursor is not invisible against its own background", (theme) => {
    const t = terminalTheme(theme);
    // Regression guard: xterm.js defaults cursor to white when unset, which
    // is invisible against a white/light background.
    expect(t.cursor).not.toBe(t.background);
  });
});
