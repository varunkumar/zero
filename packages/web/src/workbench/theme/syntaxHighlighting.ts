import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

// basicSetup's syntaxHighlighting(defaultHighlightStyle) assumes a light
// background - on ZERO_COLORS' dark editorBg, unstyled and low-priority
// tokens (plain identifiers, etc.) fall back to readable editorFg, but
// defaultHighlightStyle's own colors (e.g. comments) are tuned for white
// backgrounds and lose contrast against dark navy. These styles are keyed
// off the same Catppuccin Mocha (dark) / high-contrast (light) hues as
// theme.css and ZERO_COLORS so token colors read clearly in both themes.
const darkHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.bool, t.null, t.atom], color: "#cba6f7" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a6e3a1" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#9399b2", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float], color: "#fab387" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#89b4fa" },
  { tag: [t.typeName, t.className, t.standard(t.tagName)], color: "#f9e2af" },
  { tag: [t.propertyName, t.attributeName], color: "#74c7ec" },
  { tag: t.tagName, color: "#cba6f7" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#9399b2" },
  { tag: t.invalid, color: "#f38ba8" },
]);

const lightHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.bool, t.null, t.atom], color: "#9333ea" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#1a7f37" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float], color: "#d97706" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#0550ae" },
  { tag: [t.typeName, t.className, t.standard(t.tagName)], color: "#953800" },
  { tag: [t.propertyName, t.attributeName], color: "#0550ae" },
  { tag: t.tagName, color: "#9333ea" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#57606a" },
  { tag: t.invalid, color: "#cf222e" },
]);

export function zeroSyntaxHighlighting(theme: "light" | "dark"): Extension {
  return syntaxHighlighting(theme === "dark" ? darkHighlightStyle : lightHighlightStyle, { fallback: true });
}
