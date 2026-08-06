import type { ITheme } from "@xterm/xterm";

// xterm.js defaults cursor/cursorAccent to white when unset, which is
// invisible against a light background - both themes must set it
// explicitly, not just override background/foreground.
export function terminalTheme(theme: "light" | "dark"): ITheme {
  return theme === "dark"
    ? { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#cdd6f4", cursorAccent: "#1e1e2e" }
    : { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f", cursorAccent: "#ffffff" };
}
