// packages/daemon/src/cli/tui/theme.tsx
import React, { createContext, useContext, useState, type ReactNode } from "react";

export type ThemeName = "dark" | "light";

export interface Theme {
  name: ThemeName;
  /** Primary accent for borders, highlights, and the active prompt caret. */
  accent: string;
  /** Per-row colors for the ASCII logo mark's gradient, top -> bottom. */
  logoColors: string[];
  /** Color for collapsed tool-call summary lines. */
  toolLine: string;
}

const DARK: Theme = {
  name: "dark",
  accent: "cyan",
  logoColors: ["cyan", "cyan", "blueBright", "blue", "magenta", "magentaBright"],
  toolLine: "gray",
};

const LIGHT: Theme = {
  name: "light",
  accent: "blue",
  // Brighter ANSI variants (cyan/blueBright) wash out against a white
  // terminal background - the light palette leans on darker, higher-contrast
  // tones instead.
  logoColors: ["blue", "blue", "blueBright", "magenta", "magenta", "red"],
  toolLine: "blackBright",
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
