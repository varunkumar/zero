import { describe, expect, test } from "bun:test";
import { ZERO_COLORS } from "./colors";

describe("ZERO_COLORS", () => {
  test("dark palette matches theme.css's --zero-editor-bg/fg", () => {
    expect(ZERO_COLORS.dark.editorBg).toBe("#1e1e2e");
    expect(ZERO_COLORS.dark.editorFg).toBe("#cdd6f4");
  });

  test("light palette matches theme.css's --zero-editor-bg/fg", () => {
    expect(ZERO_COLORS.light.editorBg).toBe("#ffffff");
    expect(ZERO_COLORS.light.editorFg).toBe("#1e1e2e");
  });

  test("dark cursor is not invisible against the dark background", () => {
    expect(ZERO_COLORS.dark.cursor).not.toBe(ZERO_COLORS.dark.editorBg);
  });

  test("light cursor is not invisible against the light background", () => {
    expect(ZERO_COLORS.light.cursor).not.toBe(ZERO_COLORS.light.editorBg);
  });
});
