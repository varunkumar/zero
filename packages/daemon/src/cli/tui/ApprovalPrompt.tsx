import React from "react";
import { Box, Text, useInput } from "ink";
import type { ChatToolCall } from "@zero/core";

export interface ApprovalPromptProps {
  call: ChatToolCall;
  preview: string;
  onResolve: (approved: boolean) => void;
}

export function ApprovalPrompt({ call, preview, onResolve }: ApprovalPromptProps) {
  useInput((input, key) => {
    if (input.toLowerCase() === "y") onResolve(true);
    else if (input.toLowerCase() === "n" || key.escape) onResolve(false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">approval requested: {call.name}</Text>
      <Text>{preview}</Text>
      <Text dimColor>Approve? [y/N]</Text>
    </Box>
  );
}
