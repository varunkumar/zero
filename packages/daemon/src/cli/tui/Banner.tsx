// packages/daemon/src/cli/tui/Banner.tsx
import React from "react";
import { Box, Text } from "ink";
import { useTheme, type Theme } from "./theme";

// ASCII rendition of the actual Zero mark (packages/web/public/zero-mark-*.png):
// a rounded "Z" monogram with round end-caps, gradient cyan -> purple.
const LOGO_SHAPE = [
  "●█████████████",
  "          ████",
  "        ████  ",
  "      ████    ",
  "    ████      ",
  "█████████████●",
];

function logoRows(theme: Theme): { text: string; color: string }[] {
  return LOGO_SHAPE.map((text, i) => ({ text, color: theme.logoColors[i] ?? theme.accent }));
}

export interface BannerProps {
  cwd: string;
  version: string;
  subtitle?: string;
}

/** Boxed welcome banner shown once at the top of a screen, Claude-Code-style. */
export function Banner({ cwd, version, subtitle }: BannerProps) {
  const { theme } = useTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      {logoRows(theme).map((row, i) => (
        <Text key={i} color={row.color} bold>{row.text}</Text>
      ))}
      <Text dimColor>v{version} · {cwd}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  );
}

/** Plain-text form of the banner for use inside Ink's <Static> (which needs
 * flat, pre-rendered lines rather than a nested component). */
export function bannerLines(
  theme: Theme,
  cwd: string,
  version: string,
  subtitle?: string,
): { text: string; bold?: boolean; dim?: boolean; color?: string }[] {
  const lines = [
    ...logoRows(theme).map((row) => ({ text: row.text, bold: true, color: row.color })),
    { text: `v${version} · ${cwd}`, dim: true },
  ];
  if (subtitle) lines.push({ text: subtitle, dim: true });
  return lines;
}
