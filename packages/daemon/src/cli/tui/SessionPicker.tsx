import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ChatSessionSummary } from "@zero/protocol";
import { Banner } from "./Banner";
import { useTheme } from "./theme";

export interface SessionPickerProps {
  sessions: ChatSessionSummary[];
  onSelect: (sessionId: string | "new") => void;
  cwd: string;
  version: string;
}

interface Item { id: string | "new"; label: string }

export function SessionPicker({ sessions, onSelect, cwd, version }: SessionPickerProps) {
  const { exit } = useApp();
  const { theme } = useTheme();
  const items: Item[] = [
    { id: "new", label: "New session" },
    ...sessions.map((s) => ({
      id: s.id,
      label: `${s.title} (${new Date(s.updatedAt).toLocaleString()}, ${s.messageCount} msgs)`,
    })),
  ];
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIndex((i) => Math.min(items.length - 1, i + 1));
    else if (key.return) onSelect(items[index]!.id);
    else if (key.escape) exit();
  });

  return (
    <Box flexDirection="column">
      <Banner cwd={cwd} version={version} subtitle="Resume a session — up/down, enter · esc to quit" />
      {items.map((item, i) => (
        <Text key={item.id} color={i === index ? theme.accent : undefined}>
          {i === index ? "> " : "  "}{item.label}
        </Text>
      ))}
    </Box>
  );
}
