import { describe, expect, test } from "bun:test";
import { terminalTheme } from "./theme";
import { ZERO_COLORS } from "../theme/colors";

describe("terminalTheme", () => {
  test("dark theme matches ZERO_COLORS.dark and sets explicit cursor/cursorAccent", () => {
    const t = terminalTheme("dark");
    expect(t).toEqual({
      background: ZERO_COLORS.dark.editorBg,
      foreground: ZERO_COLORS.dark.editorFg,
      cursor: ZERO_COLORS.dark.cursor,
      cursorAccent: ZERO_COLORS.dark.editorBg,
    });
  });

  test("light theme matches ZERO_COLORS.light and sets explicit cursor/cursorAccent", () => {
    const t = terminalTheme("light");
    expect(t).toEqual({
      background: ZERO_COLORS.light.editorBg,
      foreground: ZERO_COLORS.light.editorFg,
      cursor: ZERO_COLORS.light.cursor,
      cursorAccent: ZERO_COLORS.light.editorBg,
    });
  });

  test("dark cursor is not invisible against the dark background", () => {
    const t = terminalTheme("dark");
    expect(t.cursor).not.toBe(t.background);
  });

  test("light cursor is not invisible against the light background", () => {
    const t = terminalTheme("light");
    expect(t.cursor).not.toBe(t.background);
  });
});
