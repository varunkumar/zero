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
  markdown?: boolean;
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

/** Strips a Markdown heading marker (bolding the line instead) or bullet
 * marker (replacing it with "• ") for `line.markdown` content - a small
 * subset of Markdown that reads noticeably better in a terminal without a
 * full renderer, matching the browser chat panel's much fuller Markdown
 * treatment closely enough for the common cases (headings, lists). */
function markdownLineStyle(raw: string): { text: string; bold?: boolean } {
  const heading = raw.match(/^#{1,6}\s+(.*)/);
  if (heading) return { text: heading[1] ?? "", bold: true };
  const bullet = raw.match(/^[-*+]\s+(.*)/);
  if (bullet) return { text: `• ${bullet[1] ?? ""}` };
  return { text: raw };
}

export function TextBlockView({ content, line }: { content: string; line: MessageBlockLine }) {
  const trimmed = content.replace(/\n+$/, "");
  if (!line.markdown) {
    return (
      <Text color={line.color} bold={line.bold} dimColor={line.dim}>
        {trimmed || " "}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {trimmed.split("\n").map((raw, i) => {
        const styled = markdownLineStyle(raw);
        return (
          <Text key={i} color={line.color} bold={line.bold || styled.bold} dimColor={line.dim}>
            {styled.text || " "}
          </Text>
        );
      })}
    </Box>
  );
}
