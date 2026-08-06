import { describe, expect, test } from "bun:test";
import { zeroSyntaxHighlighting } from "./syntaxHighlighting";

describe("zeroSyntaxHighlighting", () => {
  test("returns a defined extension for both themes", () => {
    expect(zeroSyntaxHighlighting("dark")).toBeDefined();
    expect(zeroSyntaxHighlighting("light")).toBeDefined();
  });

  test("dark and light themes produce distinct extensions", () => {
    // Regression guard: without a per-theme HighlightStyle, syntax colors
    // fall back to CodeMirror's light-oriented defaultHighlightStyle even in
    // dark mode, making plain tokens unreadable against a dark background.
    expect(zeroSyntaxHighlighting("dark")).not.toBe(zeroSyntaxHighlighting("light"));
  });
});
