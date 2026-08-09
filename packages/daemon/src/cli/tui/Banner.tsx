// packages/daemon/src/cli/tui/Banner.tsx
import React from "react";
import { Box, Text } from "ink";

const ZERO_LOGO = [
  "███████ ███████ ██████   █████ ",
  "     ██ ██      ██   ██ ██   ██",
  "    ██  █████   ██████  ██   ██",
  "   ██   ██      ██  ██  ██   ██",
  "  ██    ██      ██   ██ ██   ██",
  "███████ ███████ ██   ██  █████ ",
];

export interface BannerProps {
  cwd: string;
  version: string;
  subtitle?: string;
}

/** Boxed welcome banner shown once at the top of a screen, Claude-Code-style. */
export function Banner({ cwd, version, subtitle }: BannerProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      {ZERO_LOGO.map((line, i) => (
        <Text key={i} color="cyan" bold>{line}</Text>
      ))}
      <Text dimColor>v{version} · {cwd}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  );
}

/** Plain-text form of the banner for use inside Ink's <Static> (which needs
 * flat, pre-rendered lines rather than a nested component). */
export function bannerLines(
  cwd: string,
  version: string,
  subtitle?: string,
): { text: string; bold?: boolean; dim?: boolean; color?: string }[] {
  const lines = [
    ...ZERO_LOGO.map((text) => ({ text, bold: true, color: "cyan" })),
    { text: `v${version} · ${cwd}`, dim: true },
  ];
  if (subtitle) lines.push({ text: subtitle, dim: true });
  return lines;
}
