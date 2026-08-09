// packages/daemon/src/cli/tui/MessageBlock.tsx
import React from "react";
import { Box, Text } from "ink";
import type { CodeBlock as CodeBlockData } from "./markdown";
import { highlightLine } from "./highlight";

export interface MessageBlockLine {
  id: string;
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: string;
  spacer?: boolean;
}

export function CodeBlockView({ block, borderColor }: { block: CodeBlockData; borderColor: string }) {
  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={borderColor} paddingX={1}>
      {block.lang ? <Text dimColor>{block.lang}</Text> : null}
      {block.lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {highlightLine(line).map((t, j) => (
            <Text key={j} color={t.color} dimColor={t.dim}>{t.text}</Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

export function TextBlockView({ content, line }: { content: string; line: MessageBlockLine }) {
  return (
    <Text color={line.color} bold={line.bold} dimColor={line.dim}>
      {content.replace(/\n+$/, "") || " "}
    </Text>
  );
}
