import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatSessionSummary } from "@zero/protocol";

export interface SessionPickerProps {
  sessions: ChatSessionSummary[];
  onSelect: (sessionId: string | "new") => void;
}

interface Item { id: string | "new"; label: string }

export function SessionPicker({ sessions, onSelect }: SessionPickerProps) {
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
  });

  return (
    <Box flexDirection="column">
      <Text bold>Resume a session (up/down, enter):</Text>
      {items.map((item, i) => (
        <Text key={item.id} color={i === index ? "cyan" : undefined}>
          {i === index ? "> " : "  "}{item.label}
        </Text>
      ))}
    </Box>
  );
}
