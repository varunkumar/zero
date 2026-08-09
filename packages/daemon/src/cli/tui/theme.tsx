// packages/daemon/src/cli/tui/theme.tsx
import React, { createContext, useContext, useState, type ReactNode } from "react";

export type ThemeName = "dark" | "light";

export interface Theme {
  name: ThemeName;
  /** Primary accent for borders, highlights, and the active prompt caret. */
  accent: string;
  /** Color for the logo's dense "disc" fill (the "@" density class). */
  logoBg: string;
  /** Per-row colors for the logo's diagonal swoosh gradient, top -> bottom. */
  logoColors: string[];
  /** Color for collapsed tool-call summary lines. */
  toolLine: string;
  /** Color for "> user message" lines. */
  userColor: string;
  /** Color for assistant reply text (streaming and final). */
  assistantColor: string;
}

const DARK: Theme = {
  name: "dark",
  accent: "cyan",
  // Pure "black" would be invisible on a typical dark terminal background,
  // so the disc uses a dim grey that still reads as "the dark part" next
  // to the bright swoosh.
  logoBg: "gray",
  logoColors: [
    "cyan", "cyan", "cyanBright", "blueBright", "blue", "blue",
    "magenta", "magenta", "magentaBright", "magentaBright", "magenta",
  ],
  toolLine: "gray",
  userColor: "cyanBright",
  assistantColor: "white",
};

const LIGHT: Theme = {
  name: "light",
  accent: "blue",
  logoBg: "black",
  // Bright cyan/blue wash out against a white background - the light
  // palette leans on darker, higher-contrast tones instead.
  logoColors: [
    "blue", "blue", "blue", "blue", "blue", "magenta",
    "magenta", "magenta", "red", "red", "red",
  ],
  toolLine: "blackBright",
  userColor: "blue",
  assistantColor: "black",
};

const THEMES: Record<ThemeName, Theme> = { dark: DARK, light: LIGHT };

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

// Defaults to the dark theme with a no-op toggle when rendered outside a
// <ThemeProvider> (e.g. in component tests that render Banner/ChatScreen/
// SessionPicker directly) - only the real runTui.tsx entrypoint wraps <App>
// in a provider, and toggling there works normally.
const defaultContextValue: ThemeContextValue = { theme: DARK, toggle: () => {} };
const ThemeContext = createContext<ThemeContextValue>(defaultContextValue);

export function ThemeProvider({ initial = "dark", children }: { initial?: ThemeName; children: ReactNode }) {
  const [name, setName] = useState<ThemeName>(initial);
  const toggle = () => setName((n) => (n === "dark" ? "light" : "dark"));
  return <ThemeContext.Provider value={{ theme: THEMES[name], toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
