// packages/daemon/src/cli/tui/Banner.tsx
import React from "react";
import { Box, Text } from "ink";
import { useTheme, type Theme } from "./theme";

// A shaded, circular ASCII rendition of the actual Zero mark (see
// packages/web/public/zero-mark-*.png): a dark disc with a bright diagonal
// "Z" swoosh cut through it, density-shaded like a halftone print rather
// than solid block letters. "@" is the disc; "#"/"*"/"+"/"=" grade from
// dim to bright along the swoosh.
const LOGO_SHAPE = [
  "     #@@@@@      ",
  "   ++*##@@@@@    ",
  "  +==+**#@@@@@   ",
  " **+==++*##@@@@  ",
  " ##*++==+**#@@@  ",
  "@@@#**+===+**#@@ ",
  " @@@@#**+==++*#  ",
  " @@@@@##*++==+*  ",
  "  @@@@@@#**+==   ",
  "   @@@@@@##*+    ",
  "     @@@@@@      ",
];

interface Run { text: string; color: string }

function shadeRuns(theme: Theme, row: string, rowIndex: number): Run[] {
  const swooshColor = theme.logoColors[rowIndex] ?? theme.accent;
  const runs: Run[] = [];
  for (const ch of row) {
    const color = ch === "@" ? theme.logoBg : ch === " " ? "" : swooshColor;
    const last = runs[runs.length - 1];
    if (last && last.color === color) last.text += ch;
    else runs.push({ text: ch, color });
  }
  return runs;
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
      {LOGO_SHAPE.map((row, i) => (
        <Text key={i}>
          {shadeRuns(theme, row, i).map((run, j) => (
            <Text key={j} color={run.color || undefined} bold={run.color !== ""}>{run.text}</Text>
          ))}
        </Text>
      ))}
      <Text dimColor>v{version} · {cwd}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  );
}
