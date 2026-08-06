import type { ITheme } from "@xterm/xterm";
import { ZERO_COLORS } from "../theme/colors";

// xterm.js defaults cursor/cursorAccent to white when unset, which is
// invisible against a light background - both themes must set it
// explicitly, not just override background/foreground.
export function terminalTheme(theme: "light" | "dark"): ITheme {
  return theme === "dark"
    ? { background: ZERO_COLORS.dark.editorBg, foreground: ZERO_COLORS.dark.editorFg, cursor: ZERO_COLORS.dark.cursor, cursorAccent: ZERO_COLORS.dark.editorBg }
    : { background: ZERO_COLORS.light.editorBg, foreground: ZERO_COLORS.light.editorFg, cursor: ZERO_COLORS.light.cursor, cursorAccent: ZERO_COLORS.light.editorBg };
}
