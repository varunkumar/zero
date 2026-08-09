import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatToolCall } from "@zero/core";

export interface ApprovalPromptProps {
  call: ChatToolCall;
  preview: string;
  onResolve: (approved: boolean) => void;
}

export function ApprovalPrompt({ call, preview, onResolve }: ApprovalPromptProps) {
  const [selected, setSelected] = useState<"yes" | "no">("no");

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow || key.tab) {
      setSelected((s) => (s === "yes" ? "no" : "yes"));
      return;
    }
    if (key.return) { onResolve(selected === "yes"); return; }
    if (input.toLowerCase() === "y") { onResolve(true); return; }
    if (input.toLowerCase() === "n" || key.escape) onResolve(false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">approval requested: {call.name}</Text>
      <Text>{preview}</Text>
      <Box gap={2}>
        <Text
          bold={selected === "yes"}
          backgroundColor={selected === "yes" ? "green" : undefined}
          color={selected === "yes" ? "black" : "green"}
        >
          {" Yes "}
        </Text>
        <Text
          bold={selected === "no"}
          backgroundColor={selected === "no" ? "red" : undefined}
          color={selected === "no" ? "black" : "red"}
        >
          {" No "}
        </Text>
      </Box>
      <Text dimColor>←/→ to choose · enter to confirm · y/n shortcuts · esc = no</Text>
    </Box>
  );
}
